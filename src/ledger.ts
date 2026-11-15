// Per-agent books: cash left in the agent's budget and open positions.
// Paper fills and live fills both land here, so tasks and brains read one shape.

export interface Position {
  mint: string;
  /** Whole tokens held. */
  tokens: number;
  /** Raw (smallest-unit) amount, known for live fills. */
  raw?: bigint;
  decimals?: number;
  /** SOL paid in, net of what sells took back out pro rata. */
  costSol: number;
  openedAt: number;
}

export interface Fill {
  agent: string;
  side: "buy" | "sell";
  mint: string;
  sol: number;
  tokens: number;
  priceSol: number;
  ts: number;
  /** Transaction signature for live fills; "paper" otherwise. */
  sig: string;
  reason: string;
}

export interface Book {
  cashSol: number;
  startSol: number;
  positions: Map<string, Position>;
  realizedSol: number;
  trades: number;
  wins: number;
}

export class Ledger {
  readonly books = new Map<string, Book>();
  /** Gross SOL spent on buys across the swarm (checked against risk.maxSwarmSpendSol). */
  spentSol = 0;

  open(agent: string, bankrollSol: number) {
    this.books.set(agent, { cashSol: bankrollSol, startSol: bankrollSol, positions: new Map(), realizedSol: 0, trades: 0, wins: 0 });
  }

  book(agent: string): Book {
    const b = this.books.get(agent);
    if (!b) throw new Error(`no book for ${agent}`);
    return b;
  }

  applyBuy(f: Fill, extra: { raw?: bigint; decimals?: number } = {}) {
    const b = this.book(f.agent);
    b.cashSol -= f.sol;
    this.spentSol += f.sol;
    const p = b.positions.get(f.mint);
    if (p) {
      p.tokens += f.tokens;
      p.costSol += f.sol;
      if (extra.raw != null) p.raw = (p.raw ?? 0n) + extra.raw;
    } else {
      b.positions.set(f.mint, { mint: f.mint, tokens: f.tokens, costSol: f.sol, openedAt: f.ts, ...extra });
    }
    b.trades++;
  }

  applySell(f: Fill, fraction: number, rawSold?: bigint) {
    const b = this.book(f.agent);
    const p = b.positions.get(f.mint);
    if (!p) return;
    const costOut = p.costSol * fraction;
    const pnl = f.sol - costOut;
    b.cashSol += f.sol;
    b.realizedSol += pnl;
    b.trades++;
    if (pnl > 0) b.wins++;
    p.tokens -= f.tokens;
    p.costSol -= costOut;
    if (rawSold != null && p.raw != null) p.raw -= rawSold;
    if (fraction >= 0.999 || p.tokens <= 0) b.positions.delete(f.mint);
  }

  /** Cash plus positions marked at `price`. */
  equity(agent: string, price: (mint: string) => number | undefined): number {
    const b = this.book(agent);
    let v = b.cashSol;
    for (const p of b.positions.values()) v += p.tokens * (price(p.mint) ?? 0);
    return v;
  }
}
