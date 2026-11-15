// Watches token flows as they land and posts signals to the board:
//   whale_sell     a single sell of a large share of supply (react now)
//   holder_moved   a large holder moved tokens to another wallet (react now)
//   sell_pressure  the share of supply held by likely sellers crossed a threshold
//   buy_pressure   many distinct wallets buying with real size in a short window
import type { Signal } from "../board";
import { DEFAULT_RISK, HolderBook, overhang, type RiskConfig } from "./holders";
import type { ParsedTx, TokenFlow } from "./parse";
import type { PendingIntent } from "./pending";

export interface SignalConfig {
  /** A single sell of at least this % of supply is a whale_sell. */
  whaleSellPct: number;
  /** A holder of at least this % of supply moving tokens out is holder_moved. */
  holderMovedPct: number;
  /** sell_pressure fires when likely-seller overhang reaches this % of supply. */
  overhangPct: number;
  /** buy_pressure: this many distinct buyers ... */
  buyPressureBuyers: number;
  /** ... putting in at least this much SOL net ... */
  buyPressureSol: number;
  /** ... within this window. */
  windowSec: number;
  /** How long a signal stays active. */
  ttlSec: number;
  risk: RiskConfig;
}

export const DEFAULT_SIGNALS: SignalConfig = {
  whaleSellPct: 1,
  holderMovedPct: 1,
  overhangPct: 15,
  buyPressureBuyers: 8,
  buyPressureSol: 5,
  windowSec: 120,
  ttlSec: 300,
  risk: DEFAULT_RISK,
};

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export class SignalEngine {
  readonly books = new Map<string, HolderBook>();
  private lastFired = new Map<string, number>();
  /** Signatures we saw before execution, with when we saw them. */
  private pendingSeen = new Map<string, number>();

  constructor(mints: string[], private post: (s: Signal) => void, private cfg: SignalConfig = DEFAULT_SIGNALS, private ourWallets: ReadonlySet<string> = new Set()) {
    for (const m of mints) this.books.set(m, new HolderBook(m));
  }

  /**
   * Feeds intents decoded from a deshred (not yet executed) transaction.
   * Fires pending_sell / pending_move (high) and pending_activity (low).
   */
  ingestPending(intents: PendingIntent[]) {
    for (const i of intents) {
      const book = this.books.get(i.mint);
      if (!book || this.ourWallets.has(i.owner)) continue;
      if (!this.pendingSeen.has(i.signature)) this.pendingSeen.set(i.signature, i.ts);
      if (this.pendingSeen.size > 5_000) this.pendingSeen.delete(this.pendingSeen.keys().next().value!);
      const held = book.holders.get(i.owner)?.raw ?? 0n;
      const heldShare = book.share(held);
      const amtShare = i.amountRaw != null ? book.share(i.amountRaw) : 0;
      const who = `${i.owner.slice(0, 6)}…`;
      const tokens = i.amountRaw != null ? `${pct(amtShare)} of supply` : "an unknown amount";
      const common = { wallet: i.owner, signature: i.signature, ts: i.ts };
      if (i.kind === "sell" && Math.max(amtShare, heldShare) * 100 >= this.cfg.whaleSellPct) {
        this.emit(book, { kind: "pending_sell", severity: amtShare * 100 >= this.cfg.whaleSellPct ? "high" : "low", score: Math.min(1, Math.max(amtShare, heldShare) * 10), reasons: [`${who} (holds ${pct(heldShare)}) is selling ${tokens} on ${i.venue}, not yet executed`], ...common }, `p:${i.signature}`, 0);
      } else if (i.kind === "move" && heldShare * 100 >= this.cfg.holderMovedPct) {
        this.emit(book, { kind: "pending_move", severity: "high", score: Math.min(1, heldShare * 10), reasons: [`${who} (holds ${pct(heldShare)}) is moving ${tokens}${i.to ? ` to ${i.to.slice(0, 6)}…` : ""}, not yet executed`], ...common }, `p:${i.signature}`, 0);
      } else if (i.kind === "activity" && heldShare * 100 >= this.cfg.holderMovedPct) {
        this.emit(book, { kind: "pending_activity", severity: "low", score: Math.min(1, heldShare * 5), reasons: [`${who} (holds ${pct(heldShare)}) sent a transaction touching its bag (direction unknown), not yet executed`], ...common }, `p:${i.signature}`, 0);
      }
    }
  }

  /** How many ms before execution we saw this signature, if we saw it pending. */
  seenEarly(signature: string, executedAt: number): number | undefined {
    const t = this.pendingSeen.get(signature);
    if (t == null) return undefined;
    this.pendingSeen.delete(signature);
    return executedAt - t;
  }

  /** Wallets of the largest holders of each mint (to widen the deshred filter). */
  topHolderWallets(n: number): Set<string> {
    const out = new Set<string>();
    for (const b of this.books.values()) for (const h of b.top(n)) out.add(h.owner);
    return out;
  }

  /** Feeds one parsed transaction through the books and fires any signals. */
  ingest(tx: ParsedTx) {
    for (const p of tx.pools) for (const b of this.books.values()) b.markPool(p);
    const touched = new Set<string>();
    for (const f of tx.flows) {
      const book = this.books.get(f.mint);
      if (!book) continue;
      const before = book.holders.get(f.owner)?.raw ?? 0n;
      book.apply(f);
      touched.add(f.mint);
      if (this.ourWallets.has(f.owner)) continue; // our own agents never trigger signals
      this.instant(book, f, before);
    }
    for (const m of touched) this.periodic(this.books.get(m)!, tx.flows[0]?.ts ?? Date.now());
  }

  private emit(book: HolderBook, s: Omit<Signal, "mint" | "from" | "ttlMs">, key: string, cooldownMs: number) {
    const k = `${book.mint}|${key}`;
    const last = this.lastFired.get(k);
    if (last != null && s.ts - last < cooldownMs) return;
    this.lastFired.set(k, s.ts);
    this.post({ ...s, mint: book.mint, from: "stream", ttlMs: this.cfg.ttlSec * 1000 });
  }

  private instant(book: HolderBook, f: TokenFlow, before: bigint) {
    const amt = f.deltaRaw < 0n ? -f.deltaRaw : f.deltaRaw;
    const share = book.share(amt);
    if (f.kind === "sell" && share * 100 >= this.cfg.whaleSellPct) {
      this.emit(book, { kind: "whale_sell", severity: "high", score: Math.min(1, share * 10), reasons: [`${f.owner.slice(0, 6)}… sold ${pct(share)} of supply for ${f.sol.toFixed(2)} SOL`], wallet: f.owner, ts: f.ts }, `whale:${f.signature}`, 0);
    }
    if (f.kind === "transfer_out" && book.share(before) * 100 >= this.cfg.holderMovedPct) {
      const to = f.counterparty ? ` to ${f.counterparty.slice(0, 6)}…` : "";
      this.emit(book, { kind: "holder_moved", severity: "high", score: Math.min(1, book.share(before) * 10), reasons: [`holder with ${pct(book.share(before))} moved ${pct(share)} of supply${to}`], wallet: f.owner, ts: f.ts }, `moved:${f.signature}`, 0);
    }
  }

  private periodic(book: HolderBook, now: number) {
    const o = overhang(book, now, 50, this.cfg.risk);
    if (o.pct >= this.cfg.overhangPct) {
      const reasons = [`${o.pct.toFixed(1)}% of supply sits with likely sellers`, ...o.worst.map((w) => `${w.owner.slice(0, 6)}… (${pct(w.share)}): ${w.reasons.join("; ")}`)];
      this.emit(book, { kind: "sell_pressure", severity: o.pct >= this.cfg.overhangPct * 2 ? "high" : "low", score: Math.min(1, o.pct / 100), reasons, ts: now }, "overhang", 60_000);
    }
    const since = now - this.cfg.windowSec * 1000;
    const recent = book.trades.filter((t) => t.ts >= since && !this.ourWallets.has(t.owner));
    const buyers = new Set(recent.filter((t) => t.kind === "buy").map((t) => t.owner));
    const net = recent.reduce((a, t) => a + (t.kind === "buy" ? t.sol : -t.sol), 0);
    if (buyers.size >= this.cfg.buyPressureBuyers && net >= this.cfg.buyPressureSol) {
      this.emit(book, { kind: "buy_pressure", severity: "low", score: Math.min(1, net / (this.cfg.buyPressureSol * 4)), reasons: [`${buyers.size} wallets bought ${net.toFixed(2)} SOL net in ${this.cfg.windowSec}s`], ts: now }, "buyp", 60_000);
    }
  }
}
