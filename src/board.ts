// The swarm's shared board. Every agent reads it before deciding, so agents know
// what the others hold, what the others just did, and what anyone (an agent or
// the on-chain stream) has flagged about a coin.
//
// Coordination here is about risk: not piling into one coin, getting everyone
// out when a holder looks set to dump, and never buying from our own sellers.
// It deliberately has no tools for staging buys across wallets to look like
// organic demand or for trading between our own wallets.
import type { Ledger } from "./ledger";
import type { AgentSpec } from "./roster";

export type SignalKind = "whale_sell" | "holder_moved" | "sell_pressure" | "buy_pressure" | "note";

export interface Signal {
  mint: string;
  kind: SignalKind;
  /** high signals make the swarm react right away instead of waiting for the next tick. */
  severity: "low" | "high";
  /** 0..1, how strong. */
  score: number;
  reasons: string[];
  /** Wallet the signal is about, when there is one. */
  wallet?: string;
  /** "stream" or the agent id that posted it. */
  from: string;
  ts: number;
  ttlMs: number;
}

export interface CoordinationConfig {
  /** At most this many agents may hold one coin at once (unset: no limit). */
  maxAgentsPerCoin?: number;
  /** At most this much SOL (at cost) across the whole swarm in one coin. */
  maxSwarmSolPerCoin?: number;
  /** After any agent sells a coin, no agent buys it for this long, so we never buy from ourselves. */
  noSelfTradeMs: number;
  /** Signals that make every agent holding the coin sell out. */
  exitOn: SignalKind[];
  /** Signals that stop agents buying the coin while they are active. */
  avoidOn: SignalKind[];
  /** Let a buy_pressure signal wake agents targeting the coin between ticks. */
  followBuyPressure: boolean;
}

export const DEFAULT_COORDINATION: CoordinationConfig = {
  noSelfTradeMs: 30_000,
  exitOn: ["whale_sell", "holder_moved"],
  avoidOn: ["whale_sell", "holder_moved", "sell_pressure"],
  followBuyPressure: false,
};

export interface PeerView {
  agent: string;
  preset: string;
  mint: string;
  costSol: number;
}

export class Board {
  private signals: Signal[] = [];
  private lastSell = new Map<string, { agent: string; ts: number }>();
  private listeners: ((s: Signal) => void)[] = [];

  constructor(private ledger: Ledger, private specs: AgentSpec[], readonly cfg: CoordinationConfig = DEFAULT_COORDINATION) {}

  /** Posts a signal; high-severity ones are pushed to listeners (the swarm's react loop). */
  post(s: Signal) {
    this.signals.push(s);
    if (this.signals.length > 500) this.signals.splice(0, this.signals.length - 500);
    for (const l of this.listeners) l(s);
  }

  onSignal(l: (s: Signal) => void) {
    this.listeners.push(l);
  }

  active(mint: string, now: number): Signal[] {
    return this.signals.filter((s) => s.mint === mint && now - s.ts < s.ttlMs);
  }

  /** Newest active signals across every coin, for prompts and logs. */
  recent(now: number, n = 10): Signal[] {
    return this.signals.filter((s) => now - s.ts < s.ttlMs).slice(-n);
  }

  /** Every other agent's open positions. */
  peers(except?: string): PeerView[] {
    const out: PeerView[] = [];
    for (const s of this.specs) {
      if (s.id === except) continue;
      const b = this.ledger.books.get(s.id);
      if (!b) continue;
      for (const p of b.positions.values()) out.push({ agent: s.id, preset: s.preset, mint: p.mint, costSol: p.costSol });
    }
    return out;
  }

  holdersOf(mint: string): string[] {
    return this.specs.filter((s) => this.ledger.books.get(s.id)?.positions.has(mint)).map((s) => s.id);
  }

  recordSell(agent: string, mint: string, ts: number) {
    this.lastSell.set(mint, { agent, ts });
  }

  /** Why the board would refuse this buy, or null if it's fine. */
  buyBlock(agent: string, mint: string, now: number): string | null {
    const sold = this.lastSell.get(mint);
    if (sold && sold.agent !== agent && now - sold.ts < this.cfg.noSelfTradeMs) return `${sold.agent} sold this coin ${Math.round((now - sold.ts) / 1000)}s ago (no buying from our own sellers)`;
    const avoid = this.active(mint, now).find((s) => this.cfg.avoidOn.includes(s.kind));
    if (avoid) return `active ${avoid.kind} signal: ${avoid.reasons[0] ?? ""}`.trim();
    const holders = this.holdersOf(mint).filter((h) => h !== agent);
    const alreadyIn = this.ledger.books.get(agent)?.positions.has(mint);
    if (!alreadyIn && this.cfg.maxAgentsPerCoin != null && holders.length >= this.cfg.maxAgentsPerCoin) return `${holders.length} agents already hold this coin (max ${this.cfg.maxAgentsPerCoin})`;
    return null;
  }

  /** SOL the swarm can still put into this coin under maxSwarmSolPerCoin. */
  coinRoom(mint: string): number {
    if (this.cfg.maxSwarmSolPerCoin == null) return Infinity;
    const used = this.peers().filter((p) => p.mint === mint).reduce((a, p) => a + p.costSol, 0);
    return Math.max(0, this.cfg.maxSwarmSolPerCoin - used);
  }
}
