// Recent trades for the dashboard on startup: signatures that touched each mint, then
// the transactions themselves through the same balance-change parser the live stream uses.
import { parseTx, type TokenBal, type TxLike } from "./stream/parse";

interface RpcTokenBal {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount: string; decimals: number };
}
interface RpcTx {
  slot: number;
  blockTime?: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; header?: { numRequiredSignatures: number } } };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RpcTokenBal[];
    postTokenBalances?: RpcTokenBal[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
}

const tb = (b: RpcTokenBal): TokenBal => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner ?? "", amount: BigInt(b.uiTokenAmount?.amount ?? "0"), decimals: b.uiTokenAmount?.decimals ?? 0 });

export function fromRpc(tx: RpcTx): TxLike | null {
  const meta = tx.meta, msg = tx.transaction?.message;
  if (!meta || !msg) return null;
  return {
    signature: tx.transaction.signatures[0]!,
    slot: tx.slot,
    ts: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
    failed: meta.err != null,
    accountKeys: [...msg.accountKeys, ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])],
    signers: msg.header?.numRequiredSignatures ?? 1,
    fee: BigInt(meta.fee),
    preBalances: meta.preBalances.map((n) => BigInt(n)),
    postBalances: meta.postBalances.map((n) => BigInt(n)),
    preTokenBalances: (meta.preTokenBalances ?? []).map(tb),
    postTokenBalances: (meta.postTokenBalances ?? []).map(tb),
  };
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${method} ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** Signatures that touched `address`, newest first, between `until` (exclusive) and `before`. */
async function signatures(rpcUrl: string, address: string, opts: { before?: string; until?: string; limit: number; stop?: (sig: string) => boolean }) {
  const out: string[] = [];
  let before = opts.before;
  while (out.length < opts.limit) {
    const page = await rpc<{ signature: string; err: unknown }[]>(rpcUrl, "getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}), ...(opts.until ? { until: opts.until } : {}), commitment: "confirmed" }]);
    if (!page.length) return { sigs: out, done: true };
    for (const s of page) {
      if (opts.stop?.(s.signature)) return { sigs: out, done: true };
      if (!s.err) out.push(s.signature);
    }
    if (page.length < 1000) return { sigs: out, done: true };
    before = page[page.length - 1]!.signature;
  }
  return { sigs: out, done: false, next: before };
}

/** Reads the transactions and returns their buys and sells of the targets as dashboard flow lines. */
async function flowsOf(rpcUrl: string, sigs: string[], targets: ReadonlySet<string>, conc: number) {
  const out: Record<string, unknown>[] = [];
  let next = 0;
  const work = async () => {
    while (next < sigs.length) {
      const sig = sigs[next++]!;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const tx = await rpc<RpcTx | null>(rpcUrl, "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
          const like = tx && fromRpc(tx);
          if (like)
            for (const f of parseTx(like, targets).flows) {
              if (f.kind !== "buy" && f.kind !== "sell") continue;
              out.push({ ts: new Date(f.ts).toISOString(), event: "flow", kind: f.kind, mint: f.mint, owner: f.owner, tokens: f.tokens, sol: +f.sol.toFixed(6), priceSol: f.priceSol, sig: f.signature });
            }
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, work));
  return out.sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts)));
}

/**
 * Every buy and sell of the mints since launch, newest first in pages of 1,000 transactions, so
 * recent trades show up within seconds and the rest fills in behind them. Stops at trades already
 * held (`has`), then carries on from the oldest held trade (`oldest`) in case an earlier run
 * stopped before reaching the launch.
 */
export async function backfillAll(
  rpcUrl: string,
  mints: string[],
  hooks: { has: (sig: string) => boolean; oldest: () => string | undefined; onBatch: (lines: Record<string, unknown>[]) => void },
  opts: { maxTx?: number; concurrency?: number } = {},
) {
  const targets = new Set(mints), conc = opts.concurrency ?? 12;
  let budget = opts.maxTx ?? 200_000, total = 0;
  for (const mint of mints) {
    // New trades since the last run, newest first.
    let before: string | undefined;
    for (;;) {
      const r = await signatures(rpcUrl, mint, { before, limit: 1000, stop: hooks.has });
      if (r.sigs.length) { const lines = await flowsOf(rpcUrl, r.sigs, targets, conc); total += lines.length; hooks.onBatch(lines); }
      budget -= r.sigs.length;
      if (r.done || budget <= 0) break;
      before = r.next;
    }
    // Older trades than anything held, down to the launch.
    before = hooks.oldest();
    while (before && budget > 0) {
      const r = await signatures(rpcUrl, mint, { before, limit: 1000 });
      if (r.sigs.length) { const lines = await flowsOf(rpcUrl, r.sigs, targets, conc); total += lines.length; hooks.onBatch(lines); }
      budget -= r.sigs.length;
      if (r.done) break;
      before = r.next;
    }
  }
  return total;
}

/**
 * New buys and sells straight from the RPC every `everyMs`, after the newest trade held. Keeps the
 * dashboard current when the gRPC stream is down; trades the stream already delivered are dropped
 * by the dashboard's dedupe.
 */
export function pollFlows(rpcUrl: string, mints: string[], hooks: { has: (sig: string) => boolean; onLines: (lines: Record<string, unknown>[]) => void; onError?: (e: Error) => void }, everyMs = 4000) {
  const targets = new Set(mints);
  // Transactions already read, trades or not, so a transfer or failed swap isn't read again.
  const done = new Set<string>();
  let stopped = false, timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      for (const mint of mints) {
        const r = await signatures(rpcUrl, mint, { limit: 1000, stop: (s) => hooks.has(s) || done.has(s) });
        const sigs = r.sigs.slice(0, 300);
        if (sigs.length) hooks.onLines(await flowsOf(rpcUrl, sigs, targets, 6));
        for (const s of sigs) done.add(s);
        if (done.size > 20_000) for (const s of [...done].slice(0, 10_000)) done.delete(s);
      }
    } catch (e) {
      hooks.onError?.(e as Error);
    }
    if (!stopped) { timer = setTimeout(tick, everyMs); timer.unref(); }
  };
  timer = setTimeout(tick, everyMs);
  timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}
