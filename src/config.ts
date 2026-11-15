// Swarm config: who to deploy, what they trade, what else they do, and the
// guard rails around all of it. Loaded from a JSON file (swarm.example.json).
//
// Paper mode is the default. Live mode needs three things at once: "mode":
// "live" in the file, SWARM_LIVE=1 in the environment, and a wallet for each
// live group (a keypair file named by an env var). Keys never go in the file.
import { readFileSync } from "node:fs";

import { DEFAULT_COORDINATION, type CoordinationConfig, type SignalKind } from "./board";
import { DEFAULT_SIGNALS, type SignalConfig } from "./stream/signals";
import { DEFAULT_STREAM, type StreamConfig } from "./stream/types";
import { normalizeRules, PSYCHOLOGIES, type PsychologyId, type TradingRules } from "./types";

export type Mode = "paper" | "live";
export type FeedKind = "sim" | "agentchain" | "jupiter";
export type BrainKind = "traits" | "claude";

export interface Target {
  /** Token mint (the contract the agent trades against SOL). */
  mint: string;
  /** Display label; defaults to the first 4 chars of the mint. */
  symbol: string;
}

export interface GroupConfig {
  /** Names from the AgentChain roster (sim-agents.json) to deploy as-is. */
  roster?: string[];
  /** Or: a psychology preset, deployed `count` times. */
  preset?: PsychologyId;
  count?: number;
  /** Name prefix for preset agents (defaults to the preset id). */
  namePrefix?: string;
  /** Persona for preset agents (roster agents bring their own). */
  persona?: string;
  /** SOL each agent in the group starts with (paper) or may spend at most (live). */
  bankrollSol: number;
  targets: Target[];
  /** Task names to run each tick, in order. */
  tasks: string[];
  /** Exits and limits, the same shape as AgentChain trading rules. */
  rules?: TradingRules;
  brain?: BrainKind;
  /** Free-form per-task settings, e.g. { "watch": { "alertPct": 5 } }. */
  taskOptions?: Record<string, Record<string, unknown>>;
}

export interface SwarmConfig {
  mode: Mode;
  tickMs: number;
  feed: { kind: FeedKind; engineUrl?: string; jupiterUrl?: string; seed?: number };
  risk: {
    /** Transactions per minute across the whole swarm. */
    maxTxPerMin: number;
    /** Largest single buy, in SOL. */
    maxBuySol: number;
    /** Total SOL the swarm may spend on buys over its lifetime (live and paper). */
    maxSwarmSpendSol: number;
    slippageBps: number;
    /** Paper fee per trade, in basis points. */
    feeBps: number;
  };
  live: { rpcUrl?: string; jupiterUrl: string };
  /** JSONL event log; null to log to stdout only. */
  logFile: string | null;
  /** Folder of per-agent keypair files (<agent id>.json), relative to the config file. */
  walletsDir: string;
  /** SOL each live wallet keeps back for fees and token-account rent; never traded. */
  feeReserveSol: number;
  /** Create this file to stop the swarm at the next tick. */
  killFile: string;
  /** Modules that call registerTask() to add task types. Paths are relative to the config file. */
  plugins: string[];
  groups: GroupConfig[];
  coordination: CoordinationConfig;
  /** Real-time on-chain data (SVS Yellowstone gRPC). Off when absent. */
  stream: StreamConfig | null;
  signals: SignalConfig;
}

const PRESET_IDS = new Set(PSYCHOLOGIES.map((p) => p.id));
const num = (x: unknown, label: string, min: number, max: number, dflt?: number): number => {
  if (x === undefined && dflt !== undefined) return dflt;
  if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max) throw new Error(`${label} must be a number between ${min} and ${max}`);
  return x;
};
const str = (x: unknown, label: string): string => {
  if (typeof x !== "string" || !x.trim()) throw new Error(`${label} must be a non-empty string`);
  return x.trim();
};

/** Base58, 32 to 44 chars: the shape of a Solana address. */
export const isMint = (s: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export function parseConfig(raw: unknown): SwarmConfig {
  if (!raw || typeof raw !== "object") throw new Error("config must be an object");
  const r = raw as Record<string, any>;
  const mode: Mode = r.mode === "live" ? "live" : r.mode === undefined || r.mode === "paper" ? "paper" : (() => { throw new Error(`mode must be "paper" or "live"`); })();
  const feedKind = (r.feed?.kind ?? "sim") as FeedKind;
  if (!["sim", "agentchain", "jupiter"].includes(feedKind)) throw new Error("feed.kind must be sim, agentchain or jupiter");
  const groups = Array.isArray(r.groups) ? r.groups : [];
  if (!groups.length) throw new Error("groups must list at least one group");
  const cfg: SwarmConfig = {
    mode,
    tickMs: num(r.tickMs, "tickMs", 500, 3_600_000, 15_000),
    feed: { kind: feedKind, engineUrl: r.feed?.engineUrl, jupiterUrl: r.feed?.jupiterUrl, seed: r.feed?.seed },
    risk: {
      maxTxPerMin: num(r.risk?.maxTxPerMin, "risk.maxTxPerMin", 1, 600, 10),
      maxBuySol: num(r.risk?.maxBuySol, "risk.maxBuySol", 0.0001, 1_000, 0.05),
      maxSwarmSpendSol: num(r.risk?.maxSwarmSpendSol, "risk.maxSwarmSpendSol", 0, 100_000, 1),
      slippageBps: num(r.risk?.slippageBps, "risk.slippageBps", 1, 5_000, 300),
      feeBps: num(r.risk?.feeBps, "risk.feeBps", 0, 1_000, 100),
    },
    live: { rpcUrl: r.live?.rpcUrl, jupiterUrl: r.live?.jupiterUrl ?? "https://lite-api.jup.ag" },
    logFile: r.logFile === null ? null : (r.logFile ?? "swarm.log.jsonl"),
    walletsDir: r.walletsDir ?? "wallets",
    feeReserveSol: num(r.feeReserveSol, "feeReserveSol", 0, 10, 0.01),
    killFile: r.killFile ?? "SWARM_STOP",
    plugins: Array.isArray(r.plugins) ? r.plugins.map((p: unknown, i: number) => str(p, `plugins[${i}]`)) : [],
    groups: groups.map((g: any, i: number) => parseGroup(g, `groups[${i}]`)),
    coordination: parseCoordination(r.coordination),
    stream: parseStream(r.stream),
    signals: parseSignals(r.signals),
  };
  if (feedKind === "agentchain" && !cfg.feed.engineUrl) throw new Error("feed.engineUrl is required for the agentchain feed");
  return cfg;
}

function parseGroup(g: any, label: string): GroupConfig {
  if (!g || typeof g !== "object") throw new Error(`${label} must be an object`);
  const roster = Array.isArray(g.roster) ? g.roster.map((n: unknown, i: number) => str(n, `${label}.roster[${i}]`)) : undefined;
  if (!roster && !g.preset) throw new Error(`${label} needs a roster list or a preset`);
  if (g.preset && !PRESET_IDS.has(g.preset)) throw new Error(`${label}.preset must be one of ${[...PRESET_IDS].join(", ")}`);
  const targets: Target[] = (Array.isArray(g.targets) ? g.targets : []).map((t: any, i: number) => {
    const mint = str(typeof t === "string" ? t : t?.mint, `${label}.targets[${i}].mint`);
    if (!isMint(mint)) throw new Error(`${label}.targets[${i}].mint is not a Solana address`);
    return { mint, symbol: typeof t === "object" && t.symbol ? String(t.symbol) : mint.slice(0, 4) };
  });
  if (!targets.length) throw new Error(`${label}.targets must list at least one mint`);
  const tasks = Array.isArray(g.tasks) && g.tasks.length ? g.tasks.map((t: unknown, i: number) => str(t, `${label}.tasks[${i}]`)) : ["trade"];
  const brain: BrainKind = g.brain === "claude" ? "claude" : "traits";
  if (g.walletEnv !== undefined) throw new Error(`${label}.walletEnv is gone: every agent now has its own wallet in walletsDir (run with --wallets)`);
  return {
    roster,
    preset: g.preset,
    count: g.preset ? num(g.count, `${label}.count`, 1, 500, 1) : undefined,
    namePrefix: g.namePrefix,
    persona: g.persona,
    bankrollSol: num(g.bankrollSol, `${label}.bankrollSol`, 0.0001, 100_000),
    targets,
    tasks,
    rules: normalizeRules(g.rules),
    brain,
    taskOptions: g.taskOptions ?? {},
  };
}

const SIGNAL_KINDS: SignalKind[] = ["whale_sell", "holder_moved", "sell_pressure", "buy_pressure", "pending_sell", "pending_move", "pending_activity", "note"];
const kinds = (x: unknown, label: string, dflt: SignalKind[]): SignalKind[] => {
  if (x === undefined) return dflt;
  if (!Array.isArray(x) || x.some((k) => !SIGNAL_KINDS.includes(k))) throw new Error(`${label} must list signal kinds from ${SIGNAL_KINDS.join(", ")}`);
  return x;
};

function parseCoordination(c: any): CoordinationConfig {
  const d = DEFAULT_COORDINATION;
  if (c === undefined) return { ...d };
  return {
    maxAgentsPerCoin: c.maxAgentsPerCoin === undefined ? undefined : num(c.maxAgentsPerCoin, "coordination.maxAgentsPerCoin", 1, 10_000),
    maxSwarmSolPerCoin: c.maxSwarmSolPerCoin === undefined ? undefined : num(c.maxSwarmSolPerCoin, "coordination.maxSwarmSolPerCoin", 0, 100_000),
    noSelfTradeMs: num(c.noSelfTradeMs, "coordination.noSelfTradeMs", 0, 86_400_000, d.noSelfTradeMs),
    exitOn: kinds(c.exitOn, "coordination.exitOn", d.exitOn),
    avoidOn: kinds(c.avoidOn, "coordination.avoidOn", d.avoidOn),
    followBuyPressure: c.followBuyPressure === undefined ? d.followBuyPressure : Boolean(c.followBuyPressure),
  };
}

function parseStream(s: any): StreamConfig | null {
  if (s == null) return null;
  if (s.kind !== undefined && s.kind !== "svs") throw new Error(`stream.kind must be "svs"`);
  const accounts = Array.isArray(s.accounts) ? s.accounts.map((a: unknown, i: number) => str(a, `stream.accounts[${i}]`)) : [];
  for (const [i, a] of accounts.entries()) if (!isMint(a)) throw new Error(`stream.accounts[${i}] is not a Solana address`);
  const commitment = s.commitment ?? DEFAULT_STREAM.commitment;
  if (commitment !== "processed" && commitment !== "confirmed") throw new Error(`stream.commitment must be "processed" or "confirmed"`);
  return {
    kind: "svs",
    endpoint: str(s.endpoint ?? "https://basic.grpc.solanavibestation.com", "stream.endpoint"),
    tokenEnv: s.tokenEnv ?? DEFAULT_STREAM.tokenEnv,
    accounts,
    commitment,
    snapshot: s.snapshot === undefined ? DEFAULT_STREAM.snapshot : Boolean(s.snapshot),
    deshred: s.deshred === undefined ? DEFAULT_STREAM.deshred : Boolean(s.deshred),
    deshredHolders: num(s.deshredHolders, "stream.deshredHolders", 0, 1_000, DEFAULT_STREAM.deshredHolders),
  };
}

function parseSignals(s: any): SignalConfig {
  const d = DEFAULT_SIGNALS;
  const x = s ?? {};
  return {
    whaleSellPct: num(x.whaleSellPct, "signals.whaleSellPct", 0.001, 100, d.whaleSellPct),
    holderMovedPct: num(x.holderMovedPct, "signals.holderMovedPct", 0.001, 100, d.holderMovedPct),
    overhangPct: num(x.overhangPct, "signals.overhangPct", 0.1, 100, d.overhangPct),
    buyPressureBuyers: num(x.buyPressureBuyers, "signals.buyPressureBuyers", 1, 10_000, d.buyPressureBuyers),
    buyPressureSol: num(x.buyPressureSol, "signals.buyPressureSol", 0, 1_000_000, d.buyPressureSol),
    windowSec: num(x.windowSec, "signals.windowSec", 5, 86_400, d.windowSec),
    ttlSec: num(x.ttlSec, "signals.ttlSec", 5, 86_400, d.ttlSec),
    risk: {
      profitFullAt: num(x.risk?.profitFullAt, "signals.risk.profitFullAt", 1.1, 1000, d.risk.profitFullAt),
      recentSellMs: num(x.risk?.recentSellMs, "signals.risk.recentSellMs", 0, 86_400_000, d.risk.recentSellMs),
      freshWalletMs: num(x.risk?.freshWalletMs, "signals.risk.freshWalletMs", 0, 86_400_000, d.risk.freshWalletMs),
    },
  };
}

export function loadConfig(path: string): SwarmConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

/** Live trading is on only when the file and the environment both say so. */
export function liveArmed(cfg: SwarmConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return cfg.mode === "live" && env.SWARM_LIVE === "1";
}
