import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ClaudeBrain,
  ensureWallets,
  expandGroups,
  JupiterVenue,
  Ledger,
  loadKeypairFile,
  loadWallets,
  walletFileName,
  walletPath,
  JupiterFeed,
  liveArmed,
  loadRoster,
  PaperVenue,
  parseAction,
  parseConfig,
  registerTask,
  SimFeed,
  SOL_MINT,
  Swarm,
  TraitBrain,
  type Brain,
  type PriceFeed,
  type Quote,
  type SwarmConfig,
} from "../src";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

function config(over: Record<string, unknown> = {}, group: Record<string, unknown> = {}): SwarmConfig {
  return parseConfig({
    tickMs: 1000,
    logFile: null,
    killFile: join(mkdtempSync(join(tmpdir(), "swarm-")), "STOP"),
    risk: { maxTxPerMin: 600, maxBuySol: 0.05, maxSwarmSpendSol: 10 },
    groups: [{ preset: "degen", count: 3, bankrollSol: 1, targets: [{ mint: BONK, symbol: "BONK" }, WIF], tasks: ["trade", "report"], ...group }],
    ...over,
  });
}

/** A feed whose prices the test sets by hand. */
class FixedFeed implements PriceFeed {
  readonly kind = "fixed";
  prices = new Map<string, number>();
  hist = new Map<string, Quote[]>();
  async refresh(mints: string[]) {
    for (const m of mints) {
      const p = this.prices.get(m);
      if (p == null) continue;
      const h = this.hist.get(m) ?? [];
      h.push({ priceSol: p, decimals: 6, ts: 0 });
      this.hist.set(m, h);
    }
  }
  latest(m: string) {
    const h = this.hist.get(m);
    return h?.[h.length - 1];
  }
  history(m: string) {
    return this.hist.get(m) ?? [];
  }
}

const quiet = { emit: () => {} };
const paper = (cfg: SwarmConfig) => (l: any) => new PaperVenue(l, cfg.risk.slippageBps, cfg.risk.feeBps);

describe("config", () => {
  it("defaults to paper and fills risk defaults", () => {
    const c = config();
    expect(c.mode).toBe("paper");
    expect(c.risk.slippageBps).toBe(300);
    expect(c.groups[0]!.targets[1]!.symbol).toBe("EKpQ");
  });

  it("rejects bad mints, unknown presets and the old shared group wallet", () => {
    expect(() => config({}, { targets: ["not-a-mint"] })).toThrow(/Solana address/);
    expect(() => config({}, { preset: "wizard" })).toThrow(/preset/);
    expect(() => config({ mode: "live" }, { walletEnv: "W" })).toThrow(/its own wallet/);
    expect(config().walletsDir).toBe("wallets");
    expect(config().feeReserveSol).toBe(0.01);
  });

  it("arms live only with the file and SWARM_LIVE=1 together", () => {
    const c = config({ mode: "live" });
    expect(liveArmed(c, {})).toBe(false);
    expect(liveArmed(c, { SWARM_LIVE: "1" })).toBe(true);
    expect(liveArmed(config(), { SWARM_LIVE: "1" })).toBe(false);
  });
});

describe("roster", () => {
  it("deploys roster agents with their persona and rules, and presets by count", () => {
    const name = loadRoster().find((r) => r.rules)!.name;
    const specs = expandGroups(parseConfig({ groups: [{ roster: [name], preset: "sniper", count: 2, bankrollSol: 1, targets: [BONK], rules: { maxCoins: 3 } }] }).groups);
    expect(specs.map((s) => s.name)).toEqual([name, "sniper-1", "sniper-2"]);
    expect(specs[0]!.persona.length).toBeGreaterThan(20);
    expect(specs[0]!.rules.maxCoins).toBe(3);
    expect(specs[1]!.traits.paranoia).toBe(200);
  });

  it("refuses an unknown roster name", () => {
    expect(() => expandGroups(parseConfig({ groups: [{ roster: ["nobody_here"], bankrollSol: 1, targets: [BONK] }] }).groups)).toThrow(/no roster agent/);
  });
});

describe("paper swarm", () => {
  it("trades on a sim feed and keeps every book consistent", async () => {
    const cfg = config();
    const swarm = new Swarm(cfg, expandGroups(cfg.groups), { feed: new SimFeed(7), venue: paper(cfg), ...quiet });
    for (let i = 0; i < 200; i++) await swarm.tick();
    const sum = swarm.summary();
    expect(sum).toHaveLength(3);
    expect(sum.reduce((n, a) => n + a.trades, 0)).toBeGreaterThan(0);
    for (const a of swarm.agents) {
      const b = swarm.ledger.book(a.spec.id);
      expect(b.cashSol).toBeGreaterThanOrEqual(-1e-9);
      for (const p of b.positions.values()) expect(p.tokens).toBeGreaterThan(0);
    }
  });

  it("never spends past the swarm ceiling or the per-buy cap", async () => {
    const cfg = config({ risk: { maxTxPerMin: 600, maxBuySol: 0.05, maxSwarmSpendSol: 0.12 } });
    const fills: any[] = [];
    const swarm = new Swarm(cfg, expandGroups(cfg.groups), { feed: new SimFeed(3), venue: paper(cfg), emit: (l) => l.event === "fill" && fills.push(l) });
    for (let i = 0; i < 300; i++) await swarm.tick();
    expect(swarm.ledger.spentSol).toBeLessThanOrEqual(0.12 + 1e-9);
    for (const f of fills.filter((f) => f.side === "buy")) expect(f.sol).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  it("caps transactions per minute across the swarm", async () => {
    const cfg = config({ risk: { maxTxPerMin: 2, maxBuySol: 0.05, maxSwarmSpendSol: 10 } });
    const always: Brain = { kind: "always", decide: async (i) => ({ kind: "buy", mint: BONK, sol: 0.01, reason: "test" }) };
    const feed = new FixedFeed();
    feed.prices.set(BONK, 1e-5);
    const swarm = new Swarm(cfg, expandGroups(cfg.groups), { feed, venue: paper(cfg), brainFor: () => always, now: () => 0, ...quiet });
    for (let i = 0; i < 5; i++) await swarm.tick();
    expect(swarm.agents.reduce((n, a) => n + swarm.ledger.book(a.spec.id).trades, 0)).toBe(2);
  });

  it("sells on a stop loss before asking the brain", async () => {
    const cfg = config({}, { count: 1, rules: { stopLossPct: 10 } });
    const feed = new FixedFeed();
    feed.prices.set(BONK, 1e-5);
    let calls = 0;
    const brain: Brain = { kind: "b", decide: async () => (calls++ === 0 ? { kind: "buy", mint: BONK, sol: 0.05, reason: "in" } : { kind: "hold", reason: "" }) };
    const fills: any[] = [];
    const swarm = new Swarm(cfg, expandGroups(cfg.groups), { feed, venue: paper(cfg), brainFor: () => brain, emit: (l) => l.event === "fill" && fills.push(l) });
    await swarm.tick();
    feed.prices.set(BONK, 0.8e-5);
    await swarm.tick();
    expect(fills.map((f) => f.side)).toEqual(["buy", "sell"]);
    expect(fills[1].reason).toMatch(/stop loss/);
    expect(swarm.ledger.book(swarm.agents[0]!.spec.id).positions.size).toBe(0);
  });

  it("stops when the kill file appears", async () => {
    const cfg = config();
    const swarm = new Swarm(cfg, expandGroups(cfg.groups), { feed: new SimFeed(1), venue: paper(cfg), ...quiet });
    await swarm.tick();
    writeFileSync(cfg.killFile, "");
    await swarm.tick();
    expect(swarm.isStopped).toBe(true);
  });

  it("runs custom tasks registered by name", async () => {
    const seen: string[] = [];
    registerTask("ping", () => ({ name: "ping", run: async (ctx) => void seen.push(ctx.agent.id) }));
    const cfg = config({}, { count: 2, tasks: ["ping"] });
    const swarm = new Swarm(cfg, expandGroups(cfg.groups), { feed: new SimFeed(1), venue: paper(cfg), ...quiet });
    await swarm.tick();
    expect(seen.sort()).toEqual(["degen-1", "degen-2"]);
  });
});

describe("brains", () => {
  const spec = () => expandGroups(config().groups)[0]!;
  const book = () => ({ cashSol: 1, startSol: 1, positions: new Map(), realizedSol: 0, trades: 0, wins: 0 });

  it("parseAction keeps answers inside what the agent can do", () => {
    const s = spec();
    expect(parseAction(`ok {"action":"buy","mint":"${BONK}","sol":5,"reason":"x"}`, { agent: s, book: book(), maxBuySol: 0.05 })).toEqual({ kind: "buy", mint: BONK, sol: 0.05, reason: "x" });
    expect(parseAction(`{"action":"buy","mint":"${SOL_MINT}","sol":1}`, { agent: s, book: book(), maxBuySol: 1 })).toBeNull();
    expect(parseAction(`{"action":"sell","mint":"${BONK}"}`, { agent: s, book: book(), maxBuySol: 1 })).toBeNull();
    expect(parseAction("no json here", { agent: s, book: book(), maxBuySol: 1 })).toBeNull();
  });

  it("ClaudeBrain uses the model's answer and falls back on errors", async () => {
    const feed = new SimFeed(1);
    await feed.refresh([BONK]);
    const input = { agent: spec(), book: book(), feed, maxBuySol: 0.05, now: 0 };
    const ok = new ClaudeBrain({ complete: async () => '{"action":"hold","reason":"waiting"}' });
    expect(await ok.decide(input)).toEqual({ kind: "hold", reason: "waiting" });
    const fallback: Brain = { kind: "f", decide: async () => ({ kind: "hold", reason: "fallback" }) };
    const broken = new ClaudeBrain({ complete: async () => { throw new Error("down"); }, fallback });
    expect(await broken.decide(input)).toEqual({ kind: "hold", reason: "fallback" });
  });

  it("TraitBrain is deterministic per seed", async () => {
    const run = async () => {
      const feed = new SimFeed(9);
      const b = new TraitBrain("x");
      const out: string[] = [];
      for (let i = 0; i < 30; i++) {
        await feed.refresh([BONK, WIF]);
        out.push((await b.decide({ agent: spec(), book: book(), feed, maxBuySol: 0.05, now: 0 })).kind);
      }
      return out.join();
    };
    expect(await run()).toBe(await run());
  });
});

describe("JupiterFeed", () => {
  it("converts USD prices to SOL", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ [SOL_MINT]: { usdPrice: 200, decimals: 9 }, [BONK]: { usdPrice: 0.00002, decimals: 5 } }))) as unknown as typeof fetch;
    const feed = new JupiterFeed("https://example.test", fetcher);
    await feed.refresh([BONK]);
    expect(feed.latest(BONK)!.priceSol).toBeCloseTo(1e-7, 12);
    expect(feed.latest(BONK)!.decimals).toBe(5);
  });
});

describe("per-agent wallets", () => {
  const ids = () => expandGroups(config().groups).map((s) => s.id);

  it("creates one keypair file per agent, each with its own address", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "swarm-w-")), "wallets");
    expect(ensureWallets(dir, ids())).toEqual(["degen-1", "degen-2", "degen-3"]);
    const wallets = await loadWallets(dir, ids());
    const addrs = [...wallets.values()].map((w) => w.address);
    expect(new Set(addrs).size).toBe(3);
    const bytes = JSON.parse(readFileSync(walletPath(dir, "degen-1"), "utf8"));
    expect(bytes).toHaveLength(64);
    expect(statSync(walletPath(dir, "degen-1")).mode & 0o777).toBe(0o600);
    // The stored public key half matches the signer's address.
    expect((await loadKeypairFile(walletPath(dir, "degen-1"))).address).toBe(wallets.get("degen-1")!.address);
  });

  it("never overwrites an existing wallet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-w-"));
    ensureWallets(dir, ids());
    const before = readFileSync(walletPath(dir, "degen-2"), "utf8");
    expect(ensureWallets(dir, [...ids(), "degen-4"])).toEqual(["degen-4"]);
    expect(readFileSync(walletPath(dir, "degen-2"), "utf8")).toBe(before);
  });

  it("refuses to run with a missing wallet or two agents on one wallet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-w-"));
    ensureWallets(dir, ["a", "b"]);
    await expect(loadWallets(dir, ["a", "b", "c"])).rejects.toThrow(/no wallet file for c/);
    writeFileSync(walletPath(dir, "b"), readFileSync(walletPath(dir, "a")));
    await expect(loadWallets(dir, ["a", "b"])).rejects.toThrow(/same wallet/);
    expect(walletFileName("kev#2")).toBe("kev_2.json");
    expect(() => ensureWallets(dir, ["kev#2", "kev_2"])).toThrow(/share wallet file/);
  });

  it("signs each agent's swaps with that agent's wallet only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-w-"));
    ensureWallets(dir, ["a", "b"]);
    const wallets = await loadWallets(dir, ["a", "b"]);
    const venue = new JupiterVenue({ ledger: new Ledger(), rpcUrl: "http://127.0.0.1:1", jupiterUrl: "http://127.0.0.1:1", slippageBps: 100, wallets });
    expect(venue.signerFor("a").address).toBe(wallets.get("a")!.address);
    expect(venue.signerFor("b").address).not.toBe(venue.signerFor("a").address);
    expect(() => venue.signerFor("c")).toThrow(/no wallet loaded for agent c/);
  });
});
