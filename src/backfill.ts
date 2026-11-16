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

/**
 * Buys and sells of the mints over the last `windowMs`, oldest first, as dashboard flow lines.
 * Reads at most `maxTx` transactions per mint, `concurrency` at a time.
 */
export async function backfillFlows(
  rpcUrl: string,
  mints: string[],
  opts: { windowMs?: number; maxTx?: number; concurrency?: number } = {},
): Promise<Record<string, unknown>[]> {
  const windowMs = opts.windowMs ?? 60 * 60_000, maxTx = opts.maxTx ?? 600, conc = opts.concurrency ?? 8;
  const since = Math.floor((Date.now() - windowMs) / 1000);
  const targets = new Set(mints);
  const out: Record<string, unknown>[] = [];
  for (const mint of mints) {
    const sigs: string[] = [];
    let before: string | undefined;
    while (sigs.length < maxTx) {
      const page = await rpc<{ signature: string; blockTime?: number | null; err: unknown }[]>(rpcUrl, "getSignaturesForAddress", [mint, { limit: Math.min(1000, maxTx - sigs.length), ...(before ? { before } : {}), commitment: "confirmed" }]);
      if (!page.length) break;
      let old = false;
      for (const s of page) {
        if (s.blockTime != null && s.blockTime < since) { old = true; break; }
        if (!s.err) sigs.push(s.signature);
      }
      if (old || page.length < 1000) break;
      before = page[page.length - 1]!.signature;
    }
    let next = 0;
    const work = async () => {
      while (next < sigs.length) {
        const sig = sigs[next++]!;
        try {
          const tx = await rpc<RpcTx | null>(rpcUrl, "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
          const like = tx && fromRpc(tx);
          if (!like) continue;
          for (const f of parseTx(like, targets).flows) {
            if (f.kind !== "buy" && f.kind !== "sell") continue;
            out.push({ ts: new Date(f.ts).toISOString(), event: "flow", kind: f.kind, mint: f.mint, owner: f.owner, tokens: f.tokens, sol: +f.sol.toFixed(6), priceSol: f.priceSol, sig: f.signature });
          }
        } catch {
          /* skip a transaction the RPC won't return */
        }
      }
    };
    await Promise.all(Array.from({ length: conc }, work));
  }
  return out.sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts)));
}
