// Price feeds. Every feed reports a token's price in SOL per whole token and
// keeps a short history so brains can read momentum.
import { rng } from "./rng";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface Quote {
  priceSol: number;
  /** Token decimals when the feed knows them (needed for live swaps). */
  decimals?: number;
  ts: number;
}

export interface PriceFeed {
  readonly kind: string;
  /** Refreshes prices for these mints. Mints the feed can't price are left out. */
  refresh(mints: string[]): Promise<void>;
  latest(mint: string): Quote | undefined;
  /** Newest last. */
  history(mint: string): readonly Quote[];
}

const HISTORY = 120;

abstract class BaseFeed implements PriceFeed {
  abstract readonly kind: string;
  protected hist = new Map<string, Quote[]>();
  abstract refresh(mints: string[]): Promise<void>;
  latest(mint: string) {
    const h = this.hist.get(mint);
    return h?.[h.length - 1];
  }
  history(mint: string) {
    return this.hist.get(mint) ?? [];
  }
  protected push(mint: string, q: Quote) {
    const h = this.hist.get(mint) ?? [];
    h.push(q);
    if (h.length > HISTORY) h.shift();
    this.hist.set(mint, h);
  }
}

/** Offline random walk with occasional pumps and dumps. For dry runs and tests. */
export class SimFeed extends BaseFeed {
  readonly kind = "sim";
  private r: () => number;
  constructor(seed = 1, private now: () => number = Date.now) {
    super();
    this.r = rng(seed);
  }
  async refresh(mints: string[]) {
    for (const m of mints) {
      const last = this.latest(m)?.priceSol ?? 1e-6 * (0.5 + this.r());
      const shock = this.r() < 0.05 ? (this.r() - 0.4) * 0.6 : 0;
      const step = (this.r() - 0.5) * 0.06 + shock;
      this.push(m, { priceSol: Math.max(1e-12, last * (1 + step)), decimals: 6, ts: this.now() });
    }
  }
}

/** AgentChain coins, priced by an engine's REST API (/api/coins/:mint). */
export class AgentChainFeed extends BaseFeed {
  readonly kind = "agentchain";
  constructor(private engineUrl: string, private fetcher: typeof fetch = fetch) {
    super();
  }
  async refresh(mints: string[]) {
    await Promise.all(
      mints.map(async (m) => {
        try {
          const res = await this.fetcher(`${this.engineUrl.replace(/\/$/, "")}/api/coins/${m}`);
          if (!res.ok) return;
          const body = (await res.json()) as { coin?: { priceSol?: number } };
          const p = body.coin?.priceSol;
          // AgentChain coins are SPL tokens with 6 decimals.
          if (typeof p === "number" && p > 0) this.push(m, { priceSol: p, decimals: 6, ts: Date.now() });
        } catch {
          /* skip this mint this tick */
        }
      }),
    );
  }
}

/** Any Solana token Jupiter prices (Price API v3, USD), converted to SOL. */
export class JupiterFeed extends BaseFeed {
  readonly kind = "jupiter";
  constructor(private baseUrl = "https://lite-api.jup.ag", private fetcher: typeof fetch = fetch) {
    super();
  }
  async refresh(mints: string[]) {
    const ids = [...new Set([SOL_MINT, ...mints])];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      if (i > 0 && !chunk.includes(SOL_MINT)) chunk.push(SOL_MINT);
      try {
        const res = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/price/v3?ids=${chunk.join(",")}`);
        if (!res.ok) continue;
        const body = (await res.json()) as Record<string, { usdPrice?: number; decimals?: number } | null>;
        const sol = body[SOL_MINT]?.usdPrice;
        if (!sol) continue;
        const ts = Date.now();
        for (const m of chunk) {
          if (m === SOL_MINT) continue;
          const e = body[m];
          if (e?.usdPrice && e.usdPrice > 0) this.push(m, { priceSol: e.usdPrice / sol, decimals: e.decimals, ts });
        }
      } catch {
        /* try again next tick */
      }
    }
  }
}

/** Fractional change over the last `n` samples (0 when there isn't enough history). */
export function changeOver(feed: PriceFeed, mint: string, n: number): number {
  const h = feed.history(mint);
  if (h.length < 2) return 0;
  const a = h[Math.max(0, h.length - 1 - n)]!.priceSol;
  const b = h[h.length - 1]!.priceSol;
  return a > 0 ? b / a - 1 : 0;
}

/**
 * Wraps a feed and also takes trade prices from the on-chain stream as they land,
 * so momentum and exits see moves between ticks.
 */
export class LiveFeed extends BaseFeed {
  readonly kind: string;
  private lastObserved = new Map<string, number>();
  constructor(private inner: PriceFeed, private minGapMs = 1_000) {
    super();
    this.kind = `${inner.kind}+stream`;
  }
  async refresh(mints: string[]) {
    await this.inner.refresh(mints);
    for (const m of mints) {
      const q = this.inner.latest(m);
      if (q && q.ts !== this.latest(m)?.ts) this.push(m, { ...q, decimals: q.decimals ?? this.latest(m)?.decimals });
    }
  }
  /** A trade price from the stream. Throttled per mint so history stays readable. */
  observe(mint: string, priceSol: number, ts: number, decimals?: number) {
    if (!(priceSol > 0)) return;
    const last = this.lastObserved.get(mint);
    if (last != null && ts - last < this.minGapMs) return;
    this.lastObserved.set(mint, ts);
    this.push(mint, { priceSol, ts, decimals: decimals ?? this.latest(mint)?.decimals });
  }
}
