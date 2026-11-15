// Task types an agent can run each tick. "trade" is the main one; "watch" and
// "report" show the shape for other jobs. Add your own with registerTask(),
// from code or from a plugin module listed in the config's "plugins".
import type { Board } from "./board";
import type { Brain } from "./brain";
import type { PriceFeed } from "./feeds";
import type { Book, Fill, Ledger } from "./ledger";
import type { AgentSpec } from "./roster";

export interface TaskContext {
  agent: AgentSpec;
  book: Book;
  feed: PriceFeed;
  ledger: Ledger;
  brain: Brain;
  board: Board;
  now: number;
  tick: number;
  /** This task's options from the group's taskOptions. */
  options: Record<string, unknown>;
  /** Places a buy through the swarm's guard rails. Returns null if a rail refused it. */
  buy(mint: string, sol: number, reason: string): Promise<Fill | null>;
  /** urgent sells (rule exits, swarm exits) are never held back by the transaction rate. */
  sell(mint: string, fraction: number, reason: string, urgent?: boolean): Promise<Fill | null>;
  /** Largest buy the rails would allow right now. */
  buyRoom(mint?: string): number;
  log(event: string, data?: Record<string, unknown>): void;
  /** Per-agent, per-task scratch space that lives across ticks. */
  state: Record<string, unknown>;
}

export interface Task {
  readonly name: string;
  run(ctx: TaskContext): Promise<void>;
}

const registry = new Map<string, () => Task>();

export function registerTask(name: string, make: () => Task) {
  registry.set(name, make);
}

export function makeTask(name: string): Task {
  const make = registry.get(name);
  if (!make) throw new Error(`unknown task "${name}" (known: ${[...registry.keys()].join(", ")})`);
  return make();
}

export const taskNames = () => [...registry.keys()];

/** Sponsor rules first (take profit, stop loss, time exit), then the brain. */
export const tradeTask: Task = {
  name: "trade",
  async run(ctx) {
    const { rules } = ctx.agent;
    for (const p of [...ctx.book.positions.values()]) {
      const q = ctx.feed.latest(p.mint);
      if (!q) continue;
      const pnlPct = p.costSol > 0 ? ((p.tokens * q.priceSol) / p.costSol - 1) * 100 : 0;
      let why: string | null = null;
      if (rules.takeProfitPct != null && pnlPct >= rules.takeProfitPct) why = `take profit at +${pnlPct.toFixed(1)}%`;
      else if (rules.stopLossPct != null && pnlPct <= -rules.stopLossPct) why = `stop loss at ${pnlPct.toFixed(1)}%`;
      else if (rules.sellAfterMin != null && ctx.now - p.openedAt >= rules.sellAfterMin * 60_000) why = `held ${rules.sellAfterMin} min`;
      if (why) {
        await ctx.sell(p.mint, 1, `rule: ${why}`, true);
        return;
      }
    }
    const action = await ctx.brain.decide({ agent: ctx.agent, book: ctx.book, feed: ctx.feed, maxBuySol: ctx.buyRoom(), now: ctx.now, board: ctx.board });
    if (action.kind === "buy") await ctx.buy(action.mint, Math.min(action.sol, ctx.buyRoom(action.mint)), action.reason);
    else if (action.kind === "sell") await ctx.sell(action.mint, action.fraction, action.reason);
  },
};

/** Logs (and optionally POSTs to a webhook) when a target moves alertPct since the last alert. */
export const watchTask: Task = {
  name: "watch",
  async run(ctx) {
    const pct = Number(ctx.options.alertPct ?? 10);
    const hook = typeof ctx.options.webhook === "string" ? ctx.options.webhook : null;
    const marks = (ctx.state.marks ??= {}) as Record<string, number>;
    for (const t of ctx.agent.targets) {
      const q = ctx.feed.latest(t.mint);
      if (!q) continue;
      const mark = marks[t.mint];
      if (mark == null) {
        marks[t.mint] = q.priceSol;
        continue;
      }
      const move = (q.priceSol / mark - 1) * 100;
      if (Math.abs(move) >= pct) {
        marks[t.mint] = q.priceSol;
        const data = { mint: t.mint, symbol: t.symbol, movePct: +move.toFixed(2), priceSol: q.priceSol };
        ctx.log("alert", data);
        if (hook) await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: ctx.agent.name, ...data }) }).catch(() => {});
      }
    }
  },
};

/** Logs the agent's equity and P&L every `every` ticks (default 20). */
export const reportTask: Task = {
  name: "report",
  async run(ctx) {
    const every = Number(ctx.options.every ?? 20);
    if (ctx.tick % every !== 0) return;
    const equity = ctx.ledger.equity(ctx.agent.id, (m) => ctx.feed.latest(m)?.priceSol);
    ctx.log("report", {
      equitySol: +equity.toFixed(6),
      pnlPct: +((equity / ctx.book.startSol - 1) * 100).toFixed(2),
      cashSol: +ctx.book.cashSol.toFixed(6),
      open: ctx.book.positions.size,
      trades: ctx.book.trades,
    });
  },
};

registerTask("trade", () => tradeTask);
registerTask("watch", () => watchTask);
registerTask("report", () => reportTask);
