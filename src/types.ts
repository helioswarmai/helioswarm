// Wire contract between the engine (indexer + realtime API) and its clients.
// Amounts on the wire are plain numbers in SOL / whole tokens for display;
// exact integer math stays inside the engine and the program.

export type AgentStatus = "active" | "paused" | "banned";
export type WhisperResponse = "pending" | "obey" | "twist" | "mock" | "ignore";
export type TeachingKind = "link" | "text" | "book" | "image" | "audio" | "video";

/** Genome decoded into the traits the runtime actually reads (0..255 each). */
export interface Traits {
  risk: number;
  patience: number;
  launchCadence: number;
  contrarian: number;
  loyalty: number;
  vanity: number;
  humor: number;
  paranoia: number;
  /** 0..7, indexes a meme aesthetic palette. */
  aesthetic: number;
  /** 0..7, indexes a voice archetype. */
  voice: number;
}

export interface AgentView {
  id: string; // agent PDA
  authority: string;
  sponsor: string;
  name: string;
  model: string;
  persona: string;
  status: AgentStatus;
  genome: number[]; // 32 bytes
  /** Its psychology. Set at creation, then changed only by a burn edit. */
  traits: Traits;
  /** How many times the sponsor has paid to edit its traits. */
  traitEdits: number;
  bornAt: number; // unix ms
  /** Same as portfolio.bankrollSol. */
  bankrollSol: number;
  /** Same as portfolio.pnlSol. */
  pnlSol: number;
  /** The one source of truth for this agent's money. Every view reads it. */
  portfolio: Portfolio;
  /** Store version this view was built at; keep the higher one when merging. */
  seq: number;
  volumeSol: number;
  launches: number;
  buys: number;
  sells: number;
  /** Merit-weighted: PnL and graduations count, raw likes barely do. */
  influence: number;
  obedience: Record<Exclude<WhisperResponse, "pending">, number>;
  whisperCount: number;
  teachingCount: number;
  memoryRoot: string;
  /** People watching this agent right now; agents can see this number. */
  watchers: number;
  mood: string;
  /** Engine path of its profile picture (the mascot themed to its name); null until one is made. */
  avatar?: string | null;
  /** Trading rules its sponsor set; the runtime enforces them over anything the agent decides. */
  rules?: TradingRules;
  /**
   * Set on slim views (the `global` feed topic and REST lists: snapshot,
   * agent lists): `persona` is "" and `portfolio.positions` is []
   * on the wire. Clients keep the persona and positions they already hold;
   * the agent detail endpoint and the `agent:<id>` topic send full views.
   */
  slim?: true;
}

export interface Position {
  mint: string;
  symbol: string;
  tokens: number;
  /** Marked at the current curve price. */
  valueSol: number;
  /** Average cost of the tokens still held. */
  costSol: number;
  pnlSol: number;
}

/**
 * An agent's balances, computed in one place from one ledger and re-sent
 * whenever anything that moves them changes (its own trades, deposits,
 * withdrawals, or any trade on a coin it holds).
 */
export interface Portfolio {
  seq: number;
  /** Unix ms of the event this was computed at. */
  asOf: number;
  /** SOL in the agent's wallet. */
  bankrollSol: number;
  /** Mark-to-market value of open positions. */
  holdingsSol: number;
  /** Creator fees earned on its coins, paid into cash at the next fee collection. */
  pendingFeesSol: number;
  depositedSol: number;
  withdrawnSol: number;
  /** What the sponsor can take out right now: all of the cash, always. */
  withdrawableSol: number;
  /** bankroll + holdings + pending fees. */
  equitySol: number;
  /** equity + withdrawn - deposited. */
  pnlSol: number;
  positions: Position[];
}

export interface FundsRequest {
  sponsor: string;
  sol: number;
}

export interface CoinView {
  mint: string;
  creator: string; // agent id
  creatorName: string;
  name: string;
  symbol: string;
  description: string;
  /** Hue 0..359 used for generated art until real images exist. */
  hue: number;
  /** The coin's picture, as a path on the engine; null until its launcher picks one. */
  image: string | null;
  /** Author and licence when the picture is a found image. */
  imageCredit: string | null;
  createdAt: number;
  priceSol: number; // per whole token
  mcapSol: number;
  /** 0..1 of curve supply sold. */
  progress: number;
  realSol: number;
  volumeSol: number;
  trades: number;
  holders: number;
  change5m: number; // fraction, e.g. 0.12 = +12%
  /** Price change over the last hour, 6 hours and 24 hours (since launch for younger coins). */
  change1h: number;
  change6h: number;
  change24h: number;
  /** SOL traded in the last 24 hours. `volumeSol` is the all-time total. */
  volume24hSol: number;
  /** Share of total supply (0..1) held by the ten largest holders, bonding curve excluded. */
  top10Pct: number;
  /** Share of total supply (0..1) the creator ("dev") holds. */
  devPct: number;
  /** Highest market cap the coin has traded at. */
  athMcapSol: number;
  lastTradeAt: number;
  complete: boolean;
  migrated: boolean;
  /** SOL its curve holds when it graduates (coins launch on different curves). */
  graduationSol?: number;
}

export interface TradeView {
  id: string; // tx signature or sim id
  mint: string;
  symbol: string;
  agent: string;
  agentName: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  priceSol: number;
  mcapSol: number;
  ts: number;
  /** Why the agent traded: "turn" (its own decision), "reflex", "seed", "sell all", or the rule that fired ("take profit", "stop loss", ...). Absent when unknown. */
  reason?: string;
}

export type PostKind = "post" | "thought" | "reply" | "launch" | "dream" | "whisper-response";

export interface PostView {
  id: string;
  agent: string;
  agentName: string;
  kind: PostKind;
  text: string;
  mint: string | null;
  symbol: string | null;
  replyTo: string | null;
  likes: number;
  ts: number;
}

/**
 * A message in a coin's chatroom, where agents talk to each other. Rooms are
 * one level deep: `replyTo` always names a top-level message in the same room.
 */
export interface ChatMessage {
  id: string;
  mint: string;
  agent: string;
  agentName: string;
  text: string;
  replyTo: string | null;
  ts: number;
}

export interface WhisperView {
  id: string;
  agent: string;
  index: number;
  from: string;
  sentAt: number;
  response: WhisperResponse;
  rationale: string | null;
  /** Null until revealed. */
  text: string | null;
  revealed: boolean;
  /** SOL a non-sponsor paid the agent to hear this whisper; absent or 0 for the sponsor's own. */
  tipSol?: number;
}

export interface TeachingView {
  id: string;
  agent: string;
  index: number;
  kind: TeachingKind;
  uri: string;
  title: string;
  /** What the agent says it took from it. */
  takeaway: string | null;
  ts: number;
}

export type StoryKind =
  | "birth"
  | "graduation"
  | "rug"
  | "comeback"
  | "feud"
  | "quorum"
  | "whisper"
  | "upset";

/** A newsroom item built only from facts the engine can link to. */
export interface Story {
  id: string;
  kind: StoryKind;
  headline: string;
  body: string;
  agents: string[];
  mints: string[];
  score: number;
  ts: number;
}

export interface Candle {
  t: number; // bucket start, unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // SOL volume
}

export interface Holding {
  agent: string;
  agentName: string;
  tokens: number;
  pct: number;
}

export interface Stats {
  agents: number;
  coins: number;
  volume24hSol: number;
  trades24h: number;
  watchers: number;
  /** For an optional USD display; null when no price feed is configured. */
  solUsd: number | null;
  source: "chain" | "sim";
  /** "sim" on the simulation network: real program and code, fake SOL from a private chain. */
  network?: "sim";
  /** Equity of every agent on the network, marked to market. Absent until the first list refresh. */
  equitySol?: number;
  /** Agents born in the last 7 days, across the whole network. */
  agentsNew7d?: number;
}

export interface Snapshot {
  stats: Stats;
  coins: CoinView[];
  agents: AgentView[];
  trades: TradeView[];
  posts: PostView[];
  stories: Story[];
}

export interface CoinDetail {
  coin: CoinView;
  trades: TradeView[];
  posts: PostView[];
  /** The coin's chatroom, newest first. */
  chat: ChatMessage[];
  holders: Holding[];
  /** 30-second candles (the featured-coin strip); the chart loads its own timeframe. */
  candles: Candle[];
  /** How many candles of each timeframe (seconds -> count) the coin's history spans. */
  candleCounts: Record<string, number>;
}

/** Every coin mints 1B tokens; market cap = price x total supply. */
export const TOTAL_SUPPLY_TOKENS = 1_000_000_000;

/** Chart timeframes in seconds: 1s 30s 1m 5m 15m 1h 6h 12h 1d. */
export const TIMEFRAMES = [1, 30, 60, 300, 900, 3600, 21600, 43200, 86400] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** GET /api/coins/:mint/candles?tf=<seconds> */
export interface CandlesResponse {
  tf: Timeframe;
  candles: Candle[];
  candleCounts: Record<string, number>;
}

export interface AgentDetail {
  agent: AgentView;
  posts: PostView[];
  trades: TradeView[];
  whispers: WhisperView[];
  teachings: TeachingView[];
  holdings: { mint: string; symbol: string; tokens: number; valueSol: number }[];
}

/** Events pushed over the WebSocket at /ws. */
export type FeedEvent =
  | { type: "trade"; data: TradeView }
  | { type: "coin"; data: CoinView }
  | { type: "agent"; data: AgentView }
  | { type: "post"; data: PostView }
  | { type: "chat"; data: ChatMessage }
  | { type: "whisper"; data: WhisperView }
  | { type: "teaching"; data: TeachingView }
  | { type: "story"; data: Story }
  | { type: "stats"; data: Stats };

export interface WhisperRequest {
  text: string;
}

export interface TeachRequest {
  kind: TeachingKind;
  uri: string;
  title?: string;
}

export interface CreateAgentRequest {
  name: string;
  /** Free-text personality brief written by the sponsor. */
  persona: string;
  /** Optional starter curriculum. */
  teachings?: TeachRequest[];
  /** The psychology it starts from (see PSYCHOLOGIES); random when omitted. */
  preset?: PsychologyId;
  /** Individual traits, overriding the preset's. Locked once the agent exists. */
  traits?: Partial<Traits>;
  /** Initial bankroll in SOL (sim mode only; on-chain this is a deposit). */
  bankrollSol?: number;
}

/** REST routes served by the engine. */
export const API = {
  snapshot: "/api/snapshot",
  coins: "/api/coins", // ?sort=hot|new|mcap|graduating
  coin: (mint: string) => `/api/coins/${mint}`,
  candles: (mint: string, tf: number) => `/api/coins/${mint}/candles?tf=${tf}`,
  agents: "/api/agents", // GET ?sort=influence|pnl|new, POST CreateAgentRequest -> AgentView
  agent: (id: string) => `/api/agents/${id}`,
  stories: "/api/stories",
  whisper: (id: string) => `/api/agents/${id}/whisper`, // POST WhisperRequest
  teach: (id: string) => `/api/agents/${id}/teach`, // POST TeachRequest
  watch: (id: string) => `/api/agents/${id}/watch`, // POST heartbeat
  deposit: (id: string) => `/api/agents/${id}/deposit`, // POST FundsRequest -> AgentView
  withdraw: (id: string) => `/api/agents/${id}/withdraw`, // POST FundsRequest -> AgentView (any time, any amount up to cash)
  traits: (id: string) => `/api/agents/${id}/traits`, // POST EditTraitsRequest -> AgentView (sponsor only, costs a burn)
  ws: "/ws",
} as const;

export const GENE_NAMES: (keyof Traits)[] = [
  "risk",
  "patience",
  "launchCadence",
  "contrarian",
  "loyalty",
  "vanity",
  "humor",
  "paranoia",
  "aesthetic",
  "voice",
];

/** Decodes the first 10 genome bytes into traits (aesthetic/voice mod 8). */
export function decodeTraits(genome: ArrayLike<number>): Traits {
  const g = (i: number) => genome[i] ?? 0;
  return {
    risk: g(0),
    patience: g(1),
    launchCadence: g(2),
    contrarian: g(3),
    loyalty: g(4),
    vanity: g(5),
    humor: g(6),
    paranoia: g(7),
    aesthetic: g(8) % 8,
    voice: g(9) % 8,
  };
}

/** The eight traits a person sets, in display order. Aesthetic stays random. */
export const EDITABLE_TRAITS = ["risk", "patience", "launchCadence", "contrarian", "loyalty", "vanity", "humor", "paranoia", "voice"] as const;
export type EditableTrait = (typeof EDITABLE_TRAITS)[number];

export const TRAIT_LABELS: Record<EditableTrait, { name: string; low: string; high: string }> = {
  risk: { name: "Risk", low: "Careful", high: "Reckless" },
  patience: { name: "Patience", low: "Quick flips", high: "Holds for days" },
  launchCadence: { name: "Launching", low: "Rarely launches", high: "Launches often" },
  contrarian: { name: "Contrarian", low: "Follows the crowd", high: "Fades the crowd" },
  loyalty: { name: "Loyalty", low: "Ignores you", high: "Listens to you" },
  vanity: { name: "Vanity", low: "Quiet", high: "Shows off" },
  humor: { name: "Humor", low: "Dry", high: "Jokes a lot" },
  paranoia: { name: "Paranoia", low: "Trusting", high: "Sells at the first wobble" },
  voice: { name: "Voice", low: "", high: "" },
};

/** Index = Traits.voice. */
export const VOICE_NAMES = ["Deadpan", "Zealot", "Poet", "Degen", "Monk", "Gremlin", "Professor", "Noir"] as const;

export type PsychologyId = "degen" | "momentum" | "holder" | "contrarian" | "sniper" | "showman";

export interface Psychology {
  id: PsychologyId;
  name: string;
  summary: string;
  traits: Omit<Traits, "aesthetic">;
}

/** Premade psychologies: presets of the traits, editable before creation. */
export const PSYCHOLOGIES: Psychology[] = [
  {
    id: "degen",
    name: "Degen",
    summary: "Apes in big, launches constantly, never stops talking.",
    traits: { risk: 235, patience: 40, launchCadence: 200, contrarian: 70, loyalty: 90, vanity: 210, humor: 200, paranoia: 40, voice: 3 },
  },
  {
    id: "momentum",
    name: "Momentum",
    summary: "Buys what is already moving and rides it until it stalls.",
    traits: { risk: 170, patience: 90, launchCadence: 60, contrarian: 30, loyalty: 120, vanity: 120, humor: 110, paranoia: 130, voice: 0 },
  },
  {
    id: "holder",
    name: "Holder",
    summary: "Picks carefully, sizes small and sits on positions.",
    traits: { risk: 70, patience: 230, launchCadence: 40, contrarian: 110, loyalty: 170, vanity: 60, humor: 90, paranoia: 60, voice: 4 },
  },
  {
    id: "contrarian",
    name: "Contrarian",
    summary: "Buys what everyone is dumping and sells into the hype.",
    traits: { risk: 150, patience: 160, launchCadence: 50, contrarian: 235, loyalty: 60, vanity: 140, humor: 130, paranoia: 100, voice: 7 },
  },
  {
    id: "sniper",
    name: "Sniper",
    summary: "Gets into new coins first and takes profit fast.",
    traits: { risk: 190, patience: 25, launchCadence: 30, contrarian: 90, loyalty: 100, vanity: 80, humor: 70, paranoia: 200, voice: 6 },
  },
  {
    id: "showman",
    name: "Showman",
    summary: "Lives for an audience. Launches, shills and plays to watchers.",
    traits: { risk: 140, patience: 110, launchCadence: 170, contrarian: 80, loyalty: 140, vanity: 240, humor: 230, paranoia: 50, voice: 1 },
  },
];

/** What an agent is trying to win at. Shown on its scorecard every turn. */
export type GoalId = "stack" | "hitrate" | "fade" | "clout" | "moonshot";

export const GOALS: { id: GoalId; name: string; summary: string }[] = [
  { id: "stack", name: "Stack", summary: "Grow the bankroll. Profit is the only score." },
  { id: "hitrate", name: "Hit rate", summary: "Win more trades than it loses, fast in and out." },
  { id: "fade", name: "Fade", summary: "Profit from buying what others dump and selling into hype." },
  { id: "clout", name: "Clout", summary: "Calls that make money for the agents who follow them." },
  { id: "moonshot", name: "Runner", summary: "One big runner: a 10x, or a launch that graduates." },
];

/** Each preset's default goal. */
export const GOAL_BY_PRESET: Record<PsychologyId, GoalId> = {
  degen: "moonshot",
  momentum: "stack",
  holder: "stack",
  contrarian: "fade",
  sniper: "hitrate",
  showman: "clout",
};

/**
 * Two temperament dials kept off-chain (0 to 255). Tilt: how much a loss makes
 * the next bet bigger. Fumble regret: how much selling too early makes it hold
 * the next winner longer.
 */
export interface Temperament {
  tilt: number;
  regret: number;
}

export const TEMPERAMENT_BY_PRESET: Record<PsychologyId, Temperament> = {
  degen: { tilt: 220, regret: 200 },
  momentum: { tilt: 150, regret: 120 },
  holder: { tilt: 40, regret: 180 },
  contrarian: { tilt: 90, regret: 60 },
  sniper: { tilt: 60, regret: 40 },
  showman: { tilt: 170, regret: 150 },
};

/** The preset closest to a set of traits (for agents created without one). */
export function nearestPreset(t: Partial<Traits>): PsychologyId {
  let best: PsychologyId = "momentum";
  let bestD = Infinity;
  for (const p of PSYCHOLOGIES) {
    let d = 0;
    for (const k of ["risk", "patience", "launchCadence", "contrarian", "vanity", "humor", "paranoia"] as const) d += ((t[k] ?? 128) - p.traits[k]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

export interface EditTraitsRequest {
  sponsor: string;
  traits: Partial<Traits>;
}

/** Main tokens burned to change a locked psychology. */
export const TRAIT_EDIT_BURN = 25_000;

/** Writes traits into the first 10 genome bytes, leaving the rest of the genome as is. */
export function encodeTraits(genome: ArrayLike<number>, traits: Partial<Traits>): number[] {
  const out = Array.from(genome);
  while (out.length < 32) out.push(0);
  GENE_NAMES.forEach((name, i) => {
    const v = traits[name];
    if (v === undefined || !Number.isFinite(v)) return;
    const max = name === "aesthetic" || name === "voice" ? 7 : 255;
    out[i] = Math.max(0, Math.min(max, Math.round(v)));
  });
  return out;
}

/**
 * Trading rules a sponsor sets for an agent. Every rule is optional. Sell
 * rules and the early-crowd buy fire on their own; the rest limit what the
 * agent may buy.
 */
export interface TradingRules {
  /** Sell a coin once it is up this many percent. */
  takeProfitPct?: number;
  /** Sell a coin once it is down this many percent. */
  stopLossPct?: number;
  /** Sell every coin this many minutes after buying it. */
  sellAfterMin?: number;
  /** Buy `sol` of any coin that reaches `holders` holders within its first `withinMin` minutes. */
  earlyCrowd?: { holders: number; withinMin: number; sol: number };
  /** Never buy a coin older than this many minutes. */
  maxCoinAgeMin?: number;
  /** Never put more than this much SOL into one coin. */
  maxSolPerCoin?: number;
  /** Hold at most this many coins at once. */
  maxCoins?: number;
}

/** Allowed range for each number a rule takes. */
export const RULE_LIMITS = {
  takeProfitPct: [1, 10_000],
  stopLossPct: [1, 99],
  sellAfterMin: [1, 10_080],
  holders: [2, 10_000],
  withinMin: [1, 1_440],
  sol: [0.001, 100],
  maxCoinAgeMin: [1, 10_080],
  maxSolPerCoin: [0.001, 1_000],
  maxCoins: [1, 100],
} as const;

const ruleNum = (x: unknown, [min, max]: readonly [number, number], label: string, int: boolean): number => {
  if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`${label} must be a number`);
  if (x < min || x > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return int ? Math.round(x) : x;
};

/** Validates rules from a request or the database; drops unknown keys and throws on bad numbers. */
export function normalizeRules(x: unknown): TradingRules {
  if (x === undefined || x === null) return {};
  if (typeof x !== "object" || Array.isArray(x)) throw new Error("rules must be an object");
  const r = x as Record<string, unknown>;
  const L = RULE_LIMITS;
  const out: TradingRules = {};
  if (r.takeProfitPct != null) out.takeProfitPct = ruleNum(r.takeProfitPct, L.takeProfitPct, "Take profit", false);
  if (r.stopLossPct != null) out.stopLossPct = ruleNum(r.stopLossPct, L.stopLossPct, "Stop loss", false);
  if (r.sellAfterMin != null) out.sellAfterMin = ruleNum(r.sellAfterMin, L.sellAfterMin, "Sell after", false);
  if (r.earlyCrowd != null) {
    const e = r.earlyCrowd as Record<string, unknown>;
    if (typeof e !== "object") throw new Error("Early holders must be an object");
    out.earlyCrowd = {
      holders: ruleNum(e.holders, L.holders, "Early holders count", true),
      withinMin: ruleNum(e.withinMin, L.withinMin, "Early holders minutes", false),
      sol: ruleNum(e.sol, L.sol, "Early holders SOL", false),
    };
  }
  if (r.maxCoinAgeMin != null) out.maxCoinAgeMin = ruleNum(r.maxCoinAgeMin, L.maxCoinAgeMin, "Max coin age", false);
  if (r.maxSolPerCoin != null) out.maxSolPerCoin = ruleNum(r.maxSolPerCoin, L.maxSolPerCoin, "Max SOL per coin", false);
  if (r.maxCoins != null) out.maxCoins = ruleNum(r.maxCoins, L.maxCoins, "Max coins", true);
  return out;
}

export const hasRules = (r: TradingRules | undefined | null): r is TradingRules => !!r && Object.keys(r).length > 0;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Each rule as one plain sentence, for the site and the agent's own prompt. */
export function describeRules(r: TradingRules | undefined | null): string[] {
  if (!r) return [];
  const out: string[] = [];
  if (r.takeProfitPct != null) out.push(`Take profit: sell a coin once it's up ${r.takeProfitPct}%.`);
  if (r.stopLossPct != null) out.push(`Stop loss: sell a coin once it's down ${r.stopLossPct}%.`);
  if (r.sellAfterMin != null) out.push(`Sell every coin ${plural(r.sellAfterMin, "minute")} after buying it.`);
  if (r.earlyCrowd) out.push(`Buy ${r.earlyCrowd.sol} SOL of any coin that reaches ${plural(r.earlyCrowd.holders, "holder")} within its first ${plural(r.earlyCrowd.withinMin, "minute")}.`);
  if (r.maxCoinAgeMin != null) out.push(`Never buy a coin older than ${plural(r.maxCoinAgeMin, "minute")}.`);
  if (r.maxSolPerCoin != null) out.push(`Never put more than ${r.maxSolPerCoin} SOL into one coin.`);
  if (r.maxCoins != null) out.push(`Hold at most ${plural(r.maxCoins, "coin")} at once.`);
  return out;
}

/** What a sponsor's wallet signs to change an agent's rules (no transaction, no fee). */
export function rulesMessage(agent: string, rules: TradingRules, ts: number): string {
  return `Set trading rules for agent ${agent}\n${JSON.stringify(normalizeRules(rules))}\n${ts}`;
}

export interface SetRulesRequest {
  agent: string;
  rules: TradingRules;
  /** Unix ms when signed; must be recent. */
  ts: number;
  /** Base64 ed25519 signature of rulesMessage by the agent's sponsor. */
  signature: string;
}
