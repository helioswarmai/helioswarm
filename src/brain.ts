// Brains decide what an agent does with its targets on a tick.
//
// TraitBrain needs no model: it reads the agent's psychology (risk, patience,
// contrarian, paranoia) the way the engine's dice agents do. ClaudeBrain asks
// a model with the agent's persona and falls back to TraitBrain on any error,
// refusal or bad answer, so a model outage never stops the swarm.
import { describeRules, GOALS } from "./types";

import { changeOver, type PriceFeed } from "./feeds";
import type { Book } from "./ledger";
import type { AgentSpec } from "./roster";
import { hashSeed, rng } from "./rng";

export type Action =
  | { kind: "buy"; mint: string; sol: number; reason: string }
  | { kind: "sell"; mint: string; fraction: number; reason: string }
  | { kind: "hold"; reason: string };

export interface BrainInput {
  agent: AgentSpec;
  book: Book;
  feed: PriceFeed;
  /** Largest buy allowed right now (risk caps and cash already applied). */
  maxBuySol: number;
  now: number;
}

export interface Brain {
  readonly kind: string;
  decide(input: BrainInput): Promise<Action>;
}

const t01 = (x: number) => x / 255;

/** Share of spendable cash a buy may use, by risk: careful 10%, reckless 60%. */
export const riskShare = (risk: number) => 0.1 + 0.5 * t01(risk);

export class TraitBrain implements Brain {
  readonly kind = "traits";
  private r: () => number;
  constructor(seed: number | string = 1) {
    this.r = rng(typeof seed === "string" ? hashSeed(seed) : seed);
  }

  async decide({ agent, book, feed, maxBuySol }: BrainInput): Promise<Action> {
    const t = agent.traits;
    // Short window for impatient agents, long for patient ones.
    const window = Math.round(3 + 12 * t01(t.patience));
    const contrarian = t01(t.contrarian) > 0.6;

    // Sells first: an impatient or paranoid agent bails when its coin turns.
    for (const p of book.positions.values()) {
      const ch = changeOver(feed, p.mint, window);
      const bail = -0.02 - 0.15 * t01(t.patience) + 0.05 * t01(t.paranoia);
      const skim = 0.08 + 0.4 * t01(t.patience);
      if (!contrarian && ch < bail) return { kind: "sell", mint: p.mint, fraction: 1, reason: `turned ${(ch * 100).toFixed(1)}% over ${window} ticks` };
      if (contrarian ? ch > skim / 2 : ch > skim) return { kind: "sell", mint: p.mint, fraction: contrarian ? 1 : 0.5, reason: `up ${(ch * 100).toFixed(1)}%, taking some off` };
    }

    if (maxBuySol <= 0) return { kind: "hold", reason: "no cash to spend" };
    // Rank targets by the signal this agent likes: strength or weakness.
    const scored = agent.targets
      .filter((x) => feed.latest(x.mint))
      .map((x) => ({ x, ch: changeOver(feed, x.mint, window) }))
      .map((s) => ({ ...s, score: contrarian ? -s.ch : s.ch }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) return { kind: "hold", reason: "no prices yet" };
    const threshold = 0.01 + 0.04 * t01(t.paranoia) - 0.02 * t01(t.risk);
    const urge = 0.15 + 0.6 * t01(t.risk);
    if (best.score > threshold && this.r() < urge) {
      const sol = Math.min(maxBuySol, book.cashSol * riskShare(t.risk));
      if (sol > 0) return { kind: "buy", mint: best.x.mint, sol, reason: contrarian ? `buying the dip (${(best.ch * 100).toFixed(1)}%)` : `riding momentum (+${(best.ch * 100).toFixed(1)}%)` };
    }
    return { kind: "hold", reason: "nothing worth it" };
  }
}

/** Sends one Messages API request and returns the reply text. */
export type Complete = (req: { model: string; system: string; user: string; maxTokens: number }) => Promise<string>;

/** Calls the Anthropic Messages API over fetch (no SDK, so no extra deps). */
export function anthropicComplete(apiKey = process.env.ANTHROPIC_API_KEY, fetcher: typeof fetch = fetch): Complete {
  return async ({ model, system, user, maxTokens }) => {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    const res = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (body.content ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
  };
}

export interface ClaudeBrainOptions {
  model?: string;
  complete?: Complete;
  fallback?: Brain;
}

export class ClaudeBrain implements Brain {
  readonly kind = "claude";
  private complete: Complete;
  private model: string;
  private fallback: Brain;
  constructor(o: ClaudeBrainOptions = {}) {
    this.complete = o.complete ?? anthropicComplete();
    this.model = o.model ?? process.env.SWARM_MODEL ?? "claude-haiku-5-5";
    this.fallback = o.fallback ?? new TraitBrain();
  }

  async decide(input: BrainInput): Promise<Action> {
    try {
      const text = await this.complete({ model: this.model, system: systemPrompt(input.agent), user: turnPrompt(input), maxTokens: 300 });
      const a = parseAction(text, input);
      if (a) return a;
    } catch {
      /* fall through */
    }
    return this.fallback.decide(input);
  }
}

function systemPrompt(a: AgentSpec): string {
  const goal = GOALS.find((g) => g.id === a.goal);
  const rules = describeRules(a.rules);
  return [
    `You are ${a.name}, a trading agent in a swarm. ${a.persona}`,
    `Goal: ${goal?.name ?? a.goal}. ${goal?.summary ?? ""}`,
    `Traits (0-255): risk ${a.traits.risk}, patience ${a.traits.patience}, contrarian ${a.traits.contrarian}, paranoia ${a.traits.paranoia}.`,
    rules.length ? `Your sponsor's rules (enforced for you): ${rules.join(" ")}` : "",
    `Each turn answer with ONLY a JSON object: {"action":"buy"|"sell"|"hold","mint":"<mint>","sol":<number, buys only>,"fraction":<0-1, sells only>,"reason":"<under 15 words>"}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function turnPrompt({ agent, book, feed, maxBuySol }: BrainInput): string {
  const lines = [`Cash: ${book.cashSol.toFixed(4)} SOL. Largest buy allowed now: ${maxBuySol.toFixed(4)} SOL.`, "Targets:"];
  for (const t of agent.targets) {
    const q = feed.latest(t.mint);
    if (!q) continue;
    lines.push(`- ${t.symbol} ${t.mint}: price ${q.priceSol.toPrecision(4)} SOL, 5 ticks ${(changeOver(feed, t.mint, 5) * 100).toFixed(1)}%, 20 ticks ${(changeOver(feed, t.mint, 20) * 100).toFixed(1)}%`);
  }
  const pos = [...book.positions.values()];
  lines.push(pos.length ? "Positions:" : "No open positions.");
  for (const p of pos) {
    const q = feed.latest(p.mint);
    const value = q ? p.tokens * q.priceSol : 0;
    lines.push(`- ${p.mint}: cost ${p.costSol.toFixed(4)} SOL, worth ${value.toFixed(4)} SOL`);
  }
  return lines.join("\n");
}

/** Pulls the first JSON object out of a model answer and checks it against what the agent can do. */
export function parseAction(text: string, { agent, book, maxBuySol }: Pick<BrainInput, "agent" | "book" | "maxBuySol">): Action | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: any;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const reason = typeof j.reason === "string" ? j.reason.slice(0, 120) : "";
  if (j.action === "hold") return { kind: "hold", reason };
  if (j.action === "buy") {
    if (!agent.targets.some((t) => t.mint === j.mint)) return null;
    const sol = Math.min(Number(j.sol), maxBuySol);
    return Number.isFinite(sol) && sol > 0 ? { kind: "buy", mint: j.mint, sol, reason } : null;
  }
  if (j.action === "sell") {
    if (!book.positions.has(j.mint)) return null;
    const f = Number(j.fraction ?? 1);
    return Number.isFinite(f) && f > 0 ? { kind: "sell", mint: j.mint, fraction: Math.min(1, f), reason } : null;
  }
  return null;
}
