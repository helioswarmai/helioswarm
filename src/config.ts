// Swarm config: who to deploy, what they trade, what else they do, and the
// guard rails around all of it. Loaded from a JSON file (swarm.example.json).
//
// Paper mode is the default. Live mode needs three things at once: "mode":
// "live" in the file, SWARM_LIVE=1 in the environment, and a wallet for each
// live group (a keypair file named by an env var). Keys never go in the file.
import { readFileSync } from "node:fs";

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
  /** Env var holding the path to this group's keypair file (live mode only). */
  walletEnv?: string;
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
  /** Create this file to stop the swarm at the next tick. */
  killFile: string;
  /** Modules that call registerTask() to add task types. Paths are relative to the config file. */
  plugins: string[];
  groups: GroupConfig[];
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
    killFile: r.killFile ?? "SWARM_STOP",
    plugins: Array.isArray(r.plugins) ? r.plugins.map((p: unknown, i: number) => str(p, `plugins[${i}]`)) : [],
    groups: groups.map((g: any, i: number) => parseGroup(g, `groups[${i}]`, mode)),
  };
  if (feedKind === "agentchain" && !cfg.feed.engineUrl) throw new Error("feed.engineUrl is required for the agentchain feed");
  return cfg;
}

function parseGroup(g: any, label: string, mode: Mode): GroupConfig {
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
  if (mode === "live" && !g.walletEnv) throw new Error(`${label}.walletEnv is required in live mode (the env var naming the group's keypair file)`);
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
    walletEnv: g.walletEnv,
    taskOptions: g.taskOptions ?? {},
  };
}

export function loadConfig(path: string): SwarmConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

/** Live trading is on only when the file and the environment both say so. */
export function liveArmed(cfg: SwarmConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return cfg.mode === "live" && env.SWARM_LIVE === "1";
}
