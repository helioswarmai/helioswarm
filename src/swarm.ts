// The swarm supervisor: holds every agent, refreshes prices once per tick,
// runs each agent's tasks, and puts every order through the same guard
// rails (per-buy cap, agent cash, per-coin and coin-count rules, a swarm-wide
// spend ceiling, a swarm-wide transaction rate, and a kill file).
import { appendFileSync, existsSync } from "node:fs";

import { ClaudeBrain, TraitBrain, type Brain } from "./brain";
import type { SwarmConfig } from "./config";
import type { PriceFeed } from "./feeds";
import { Ledger, type Fill } from "./ledger";
import type { AgentSpec } from "./roster";
import { makeTask, type Task, type TaskContext } from "./tasks";
import type { Venue } from "./venues";
import { Board, type Signal } from "./board";

export interface SwarmDeps {
  feed: PriceFeed;
  /** Built from the ledger the swarm owns. */
  venue: (ledger: Ledger) => Venue;
  brainFor?: (agent: AgentSpec) => Brain;
  now?: () => number;
  /** Where events go besides the log file. */
  emit?: (line: Record<string, unknown>) => void;
}

interface Running {
  spec: AgentSpec;
  brain: Brain;
  tasks: Task[];
  state: Record<string, Record<string, unknown>>;
}

export class Swarm {
  readonly ledger = new Ledger();
  readonly venue: Venue;
  readonly board: Board;
  private lock: Promise<unknown> = Promise.resolve();
  readonly agents: Running[];
  private feed: PriceFeed;
  private now: () => number;
  private emit: (line: Record<string, unknown>) => void;
  private txTimes: number[] = [];
  private tickNo = 0;
  private stopped = false;

  constructor(private cfg: SwarmConfig, specs: AgentSpec[], deps: SwarmDeps) {
    this.feed = deps.feed;
    this.now = deps.now ?? Date.now;
    this.emit = deps.emit ?? ((l) => console.log(JSON.stringify(l)));
    this.venue = deps.venue(this.ledger);
    const brainFor = deps.brainFor ?? ((a: AgentSpec) => (a.brain === "claude" ? new ClaudeBrain({ fallback: new TraitBrain(a.id) }) : new TraitBrain(a.id)));
    this.agents = specs.map((spec) => {
      this.ledger.open(spec.id, spec.bankrollSol);
      return { spec, brain: brainFor(spec), tasks: spec.tasks.map(makeTask), state: {} };
    });
    this.board = new Board(this.ledger, specs, cfg.coordination);
    this.board.onSignal((s) => {
      this.log("signal", { ...s });
      void this.react(s);
    });
  }

  /** Runs fn with no tick or reaction running at the same time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /**
   * Reacts to a signal between ticks. High exit signals sell every agent out of
   * that coin now; buy_pressure (when followBuyPressure is on) lets agents that
   * target the coin run their trade task early.
   */
  react(s: Signal): Promise<void> {
    return this.exclusive(async () => {
      if (this.stopped) return;
      const c = this.cfg.coordination;
      if (s.severity === "high" && c.exitOn.includes(s.kind)) {
        for (const a of this.agents) {
          if (!this.ledger.book(a.spec.id).positions.has(s.mint)) continue;
          const trade = a.tasks.find((t) => t.name === "trade") ?? a.tasks[0];
          if (!trade) continue;
          await this.context(a, trade).sell(s.mint, 1, `swarm exit on ${s.kind}: ${s.reasons[0] ?? ""}`.slice(0, 160), true);
        }
      } else if (s.kind === "buy_pressure" && c.followBuyPressure) {
        for (const a of this.agents) {
          if (!a.spec.targets.some((t) => t.mint === s.mint)) continue;
          const trade = a.tasks.find((t) => t.name === "trade");
          if (trade) await trade.run(this.context(a, trade)).catch((e) => this.log("task_error", { agent: a.spec.id, task: "trade", error: (e as Error).message }));
        }
      }
    });
  }

  get mints(): string[] {
    return [...new Set(this.agents.flatMap((a) => a.spec.targets.map((t) => t.mint)))];
  }

  log(event: string, data: Record<string, unknown> = {}) {
    const line = { ts: new Date(this.now()).toISOString(), event, ...data };
    this.emit(line);
    if (this.cfg.logFile) appendFileSync(this.cfg.logFile, JSON.stringify(line) + "\n");
  }

  stop(why = "stopped") {
    if (!this.stopped) this.log("stop", { why });
    this.stopped = true;
  }

  get isStopped() {
    return this.stopped;
  }

  /** One pass: prices, then every agent's tasks in order. */
  tick(): Promise<void> {
    return this.exclusive(() => this.tickInner());
  }

  private async tickInner(): Promise<void> {
    if (this.stopped) return;
    if (existsSync(this.cfg.killFile)) return this.stop(`kill file ${this.cfg.killFile} found`);
    this.tickNo++;
    await this.feed.refresh(this.mints);
    // Rotate who goes first so the shared transaction budget is spread fairly.
    const n = this.agents.length;
    for (let k = 0; k < n; k++) {
      const a = this.agents[(k + this.tickNo) % n]!;
      for (const task of a.tasks) {
        if (this.stopped) return;
        try {
          await task.run(this.context(a, task));
        } catch (e) {
          this.log("task_error", { agent: a.spec.id, task: task.name, error: (e as Error).message });
        }
      }
    }
  }

  /** Runs until stopped, or for `ticks` ticks when given. */
  async run(ticks?: number): Promise<void> {
    this.log("start", { mode: this.venue.kind, agents: this.agents.length, mints: this.mints.length, feed: this.feed.kind });
    for (let i = 0; !this.stopped && (ticks == null || i < ticks); i++) {
      const started = this.now();
      await this.tick();
      if (ticks != null && i === ticks - 1) break;
      const wait = Math.max(0, this.cfg.tickMs - (this.now() - started));
      await new Promise((r) => setTimeout(r, wait));
    }
    this.log("summary", { agents: this.summary() });
  }

  summary() {
    const price = (m: string) => this.feed.latest(m)?.priceSol;
    return this.agents.map(({ spec }) => {
      const b = this.ledger.book(spec.id);
      const equity = this.ledger.equity(spec.id, price);
      return {
        agent: spec.id,
        preset: spec.preset,
        equitySol: +equity.toFixed(6),
        pnlPct: +((equity / b.startSol - 1) * 100).toFixed(2),
        trades: b.trades,
        open: b.positions.size,
      };
    });
  }

  /** Largest buy the rails allow for this agent (and coin) right now. */
  buyRoom(spec: AgentSpec, mint?: string): number {
    const b = this.ledger.book(spec.id);
    let room = Math.min(this.cfg.risk.maxBuySol, b.cashSol, this.cfg.risk.maxSwarmSpendSol - this.ledger.spentSol);
    const r = spec.rules;
    if (mint) {
      room = Math.min(room, this.board.coinRoom(mint));
      const held = b.positions.get(mint);
      if (r.maxSolPerCoin != null) room = Math.min(room, r.maxSolPerCoin - (held?.costSol ?? 0));
      if (!held && r.maxCoins != null && b.positions.size >= r.maxCoins) room = 0;
    }
    return Math.max(0, room);
  }

  private rateOk(): boolean {
    const now = this.now();
    this.txTimes = this.txTimes.filter((t) => now - t < 60_000);
    return this.txTimes.length < this.cfg.risk.maxTxPerMin;
  }

  private context(a: Running, task: Task): TaskContext {
    const { spec } = a;
    const now = this.now();
    const order = { agent: spec.id, group: spec.group, now };
    return {
      agent: spec,
      book: this.ledger.book(spec.id),
      feed: this.feed,
      ledger: this.ledger,
      brain: a.brain,
      board: this.board,
      now,
      tick: this.tickNo,
      options: spec.taskOptions[task.name] ?? {},
      state: (a.state[task.name] ??= {}),
      buyRoom: (mint) => this.buyRoom(spec, mint),
      log: (event, data) => this.log(event, { agent: spec.id, task: task.name, ...data }),
      buy: async (mint, sol, reason) => {
        if (!spec.targets.some((t) => t.mint === mint)) return this.refuse(spec, "buy", mint, "not one of this agent's targets");
        const q = this.feed.latest(mint);
        if (!q) return this.refuse(spec, "buy", mint, "no price");
        const blocked = this.board.buyBlock(spec.id, mint, now);
        if (blocked) return this.refuse(spec, "buy", mint, blocked);
        const room = this.buyRoom(spec, mint);
        const size = Math.min(sol, room);
        if (size <= 0) return this.refuse(spec, "buy", mint, "no room under the risk caps");
        if (!this.rateOk()) return this.refuse(spec, "buy", mint, "swarm transaction rate reached");
        this.txTimes.push(now);
        return this.filled(await this.venue.buy({ ...order, reason }, mint, size, q));
      },
      sell: async (mint, fraction, reason, urgent = false) => {
        const q = this.feed.latest(mint);
        if (!q) return this.refuse(spec, "sell", mint, "no price");
        if (!this.ledger.book(spec.id).positions.has(mint)) return null;
        if (!urgent && !this.rateOk()) return this.refuse(spec, "sell", mint, "swarm transaction rate reached");
        this.txTimes.push(now);
        const f = this.filled(await this.venue.sell({ ...order, reason }, mint, Math.min(1, Math.max(0, fraction)), q));
        if (f) this.board.recordSell(spec.id, mint, now);
        return f;
      },
    };
  }

  private filled(f: Fill | null): Fill | null {
    if (f) this.log("fill", { ...f });
    return f;
  }

  private refuse(spec: AgentSpec, side: string, mint: string, why: string): null {
    this.log("refused", { agent: spec.id, side, mint, why });
    return null;
  }
}
