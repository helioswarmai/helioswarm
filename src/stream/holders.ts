// A live holder book per token: every wallet's balance, what it paid, when it
// bought and sold, and where its tokens came from. Seeded from an RPC snapshot
// of the largest holders, then kept current from the transaction stream.
import { address, createSolanaRpc } from "@solana/kit";

import type { TokenFlow } from "./parse";
import type { TokenAccountIndex } from "./pending";

export interface Holder {
  owner: string;
  raw: bigint;
  /** SOL paid for the tokens it still holds (seen buys only; 0 when unknown). */
  costSol: number;
  /** Raw tokens whose cost we know. */
  costedRaw: bigint;
  buys: number;
  sells: number;
  soldRaw: bigint;
  firstSeen: number;
  lastBuyAt?: number;
  lastSellAt?: number;
  /** Set when the wallet received tokens moved from another holder. */
  fundedBy?: string;
  receivedAt?: number;
  /** Raw tokens it has moved out to other wallets. */
  movedOutRaw: bigint;
  /** Came from the startup snapshot, so its history before then is unknown. */
  snapshot: boolean;
}

export interface Trade {
  ts: number;
  owner: string;
  kind: "buy" | "sell";
  sol: number;
  raw: bigint;
}

export class HolderBook {
  readonly holders = new Map<string, Holder>();
  readonly pools = new Set<string>();
  readonly trades: Trade[] = [];
  decimals = 6;
  /** Total supply in raw units, when known (from RPC). */
  supplyRaw?: bigint;
  lastPriceSol?: number;
  lastTradeAt?: number;

  constructor(readonly mint: string, private keepTradesMs = 30 * 60_000) {}

  private get(owner: string, ts: number): Holder {
    let h = this.holders.get(owner);
    if (!h) {
      h = { owner, raw: 0n, costSol: 0, costedRaw: 0n, buys: 0, sells: 0, soldRaw: 0n, firstSeen: ts, movedOutRaw: 0n, snapshot: false };
      this.holders.set(owner, h);
    }
    return h;
  }

  seed(owner: string, raw: bigint, ts: number) {
    const h = this.get(owner, ts);
    h.raw = raw;
    h.snapshot = true;
  }

  markPool(owner: string) {
    this.pools.add(owner);
    this.holders.delete(owner);
  }

  /** Share of supply (0..1) a raw amount is. Falls back to the tracked total when supply is unknown. */
  share(raw: bigint): number {
    const total = this.supplyRaw ?? this.trackedRaw();
    return total > 0n ? Number(raw) / Number(total) : 0;
  }

  trackedRaw(): bigint {
    let t = 0n;
    for (const h of this.holders.values()) t += h.raw;
    return t;
  }

  apply(f: TokenFlow) {
    if (f.mint !== this.mint || this.pools.has(f.owner)) return;
    this.decimals = f.decimals;
    const h = this.get(f.owner, f.ts);
    const amt = f.deltaRaw < 0n ? -f.deltaRaw : f.deltaRaw;
    if (f.kind === "buy") {
      h.raw += amt;
      h.costSol += f.sol;
      h.costedRaw += amt;
      h.buys++;
      h.lastBuyAt = f.ts;
      if (f.priceSol) this.lastPriceSol = f.priceSol;
      this.lastTradeAt = f.ts;
      this.trades.push({ ts: f.ts, owner: f.owner, kind: "buy", sol: f.sol, raw: amt });
    } else if (f.kind === "sell") {
      this.reduce(h, amt);
      h.sells++;
      h.soldRaw += amt;
      h.lastSellAt = f.ts;
      if (f.priceSol) this.lastPriceSol = f.priceSol;
      this.lastTradeAt = f.ts;
      this.trades.push({ ts: f.ts, owner: f.owner, kind: "sell", sol: f.sol, raw: amt });
    } else if (f.kind === "transfer_out") {
      this.reduce(h, amt);
      h.movedOutRaw += amt;
    } else {
      h.raw += amt;
      if (f.counterparty) {
        h.fundedBy = f.counterparty;
        h.receivedAt = f.ts;
      }
    }
    if (h.raw <= 0n && !h.fundedBy && h.movedOutRaw === 0n) this.holders.delete(f.owner);
    const cutoff = f.ts - this.keepTradesMs;
    while (this.trades.length && this.trades[0]!.ts < cutoff) this.trades.shift();
  }

  private reduce(h: Holder, amt: bigint) {
    if (h.raw > 0n && h.costedRaw > 0n) {
      const out = amt > h.costedRaw ? h.costedRaw : amt;
      h.costSol -= h.costSol * (Number(out) / Number(h.costedRaw));
      h.costedRaw -= out;
    }
    h.raw = h.raw > amt ? h.raw - amt : 0n;
  }

  top(n: number): Holder[] {
    return [...this.holders.values()].sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0)).slice(0, n);
  }
}

export interface RiskConfig {
  /** Profit multiple at which a holder's "take profit" urge is maxed out. */
  profitFullAt: number;
  /** A holder that sold within this window is "already selling". */
  recentSellMs: number;
  /** A wallet that received moved tokens within this window is a likely seller. */
  freshWalletMs: number;
}

export const DEFAULT_RISK: RiskConfig = { profitFullAt: 3, recentSellMs: 30 * 60_000, freshWalletMs: 60 * 60_000 };

export interface HolderRisk {
  owner: string;
  share: number;
  /** 0..1 chance-like score that this wallet sells soon. */
  risk: number;
  reasons: string[];
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

/** How likely a holder is to sell soon, and why. Heuristics, not a model. */
export function holderRisk(book: HolderBook, h: Holder, now: number, cfg: RiskConfig = DEFAULT_RISK): HolderRisk {
  const share = book.share(h.raw);
  const reasons: string[] = [];
  let r = 0;
  const px = book.lastPriceSol;
  if (px && h.costSol > 0 && h.costedRaw > 0n) {
    const value = (Number(h.costedRaw) / 10 ** book.decimals) * px;
    const mult = value / h.costSol;
    if (mult > 1.2) {
      const p = clamp((mult - 1) / (cfg.profitFullAt - 1)) * 0.45;
      r += p;
      reasons.push(`up ${mult.toFixed(1)}x on its entry`);
    }
  }
  if (h.lastSellAt != null && now - h.lastSellAt < cfg.recentSellMs) {
    r += 0.35;
    reasons.push(`sold ${(Number(h.soldRaw) / 10 ** book.decimals).toPrecision(3)} tokens recently and still holds`);
  }
  if (h.fundedBy && h.receivedAt != null && now - h.receivedAt < cfg.freshWalletMs) {
    r += 0.45;
    reasons.push(`received tokens moved from ${h.fundedBy.slice(0, 6)}… (a common step before dumping)`);
  }
  if (h.movedOutRaw > 0n && h.raw > 0n) {
    r += 0.15;
    reasons.push("has been splitting its bag across wallets");
  }
  if (h.lastBuyAt != null && now - h.lastBuyAt < 5 * 60_000 && reasons.some((x) => x.startsWith("up"))) {
    r += 0.15;
    reasons.push("quick flip in profit");
  }
  return { owner: h.owner, share, risk: clamp(r), reasons };
}

/** Share of supply likely to hit the market soon: sum over top holders of share x risk. */
export function overhang(book: HolderBook, now: number, topN = 50, cfg: RiskConfig = DEFAULT_RISK): { pct: number; worst: HolderRisk[] } {
  const risks = book
    .top(topN)
    .map((h) => holderRisk(book, h, now, cfg))
    .filter((x) => x.risk > 0);
  const pct = risks.reduce((a, x) => a + x.share * x.risk, 0) * 100;
  return { pct, worst: risks.sort((a, b) => b.share * b.risk - a.share * a.risk).slice(0, 3) };
}

/** Seeds a book from RPC: supply plus the largest token accounts and their owners. */
export async function snapshotHolders(rpcUrl: string, book: HolderBook, now = Date.now(), index?: TokenAccountIndex) {
  const rpc = createSolanaRpc(rpcUrl);
  const mint = address(book.mint);
  const supply = await rpc.getTokenSupply(mint).send();
  book.supplyRaw = BigInt(supply.value.amount);
  book.decimals = supply.value.decimals;
  const largest = await rpc.getTokenLargestAccounts(mint).send();
  const accounts = largest.value.map((a) => a.address);
  if (!accounts.length) return;
  const infos = await rpc.getMultipleAccounts(accounts, { encoding: "jsonParsed" }).send();
  infos.value.forEach((acc, i) => {
    const parsed = (acc?.data as { parsed?: { info?: { owner?: string } } } | undefined)?.parsed?.info?.owner;
    if (!parsed) return;
    book.seed(parsed, BigInt(largest.value[i]!.amount), now);
    index?.set(largest.value[i]!.address, { owner: parsed, mint: book.mint });
  });
}
