// Where orders go. PaperVenue fills at the feed price with slippage and a fee.
// JupiterVenue swaps for real through Jupiter on Solana mainnet and is only
// built when live trading is armed (config mode "live" and SWARM_LIVE=1).
import {
  address,
  createSolanaRpc,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  signTransaction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";

import { SOL_MINT, type Quote } from "./feeds";
import type { Fill, Ledger } from "./ledger";

export interface OrderContext {
  agent: string;
  group: number;
  reason: string;
  now: number;
}

export interface Venue {
  readonly kind: "paper" | "jupiter";
  buy(ctx: OrderContext, mint: string, sol: number, quote: Quote): Promise<Fill | null>;
  sell(ctx: OrderContext, mint: string, fraction: number, quote: Quote): Promise<Fill | null>;
}

export class PaperVenue implements Venue {
  readonly kind = "paper";
  constructor(private ledger: Ledger, private slippageBps: number, private feeBps: number) {}

  async buy(ctx: OrderContext, mint: string, sol: number, q: Quote): Promise<Fill | null> {
    const px = q.priceSol * (1 + this.slippageBps / 2 / 10_000);
    const tokens = (sol * (1 - this.feeBps / 10_000)) / px;
    const f: Fill = { agent: ctx.agent, side: "buy", mint, sol, tokens, priceSol: px, ts: ctx.now, sig: "paper", reason: ctx.reason };
    this.ledger.applyBuy(f);
    return f;
  }

  async sell(ctx: OrderContext, mint: string, fraction: number, q: Quote): Promise<Fill | null> {
    const p = this.ledger.book(ctx.agent).positions.get(mint);
    if (!p) return null;
    const tokens = p.tokens * fraction;
    const px = q.priceSol * (1 - this.slippageBps / 2 / 10_000);
    const sol = tokens * px * (1 - this.feeBps / 10_000);
    const f: Fill = { agent: ctx.agent, side: "sell", mint, sol, tokens, priceSol: px, ts: ctx.now, sig: "paper", reason: ctx.reason };
    this.ledger.applySell(f, fraction);
    return f;
  }
}

interface JupQuote {
  inAmount: string;
  outAmount: string;
  [k: string]: unknown;
}

export interface JupiterVenueOptions {
  ledger: Ledger;
  rpcUrl: string;
  jupiterUrl: string;
  slippageBps: number;
  /** One signer per agent id: every agent trades from its own wallet. */
  wallets: Map<string, KeyPairSigner>;
  /** Priority fee ceiling per swap, in lamports. */
  maxPriorityLamports?: number;
  fetcher?: typeof fetch;
}

export class JupiterVenue implements Venue {
  readonly kind = "jupiter";
  private rpc;
  private fetcher: typeof fetch;
  constructor(private o: JupiterVenueOptions) {
    this.rpc = createSolanaRpc(o.rpcUrl);
    this.fetcher = o.fetcher ?? fetch;
  }

  async buy(ctx: OrderContext, mint: string, sol: number, q: Quote): Promise<Fill | null> {
    const lamports = BigInt(Math.floor(sol * 1e9));
    const quote = await this.quote(SOL_MINT, mint, lamports);
    const sig = await this.swap(ctx.agent, quote);
    const decimals = q.decimals ?? 6;
    const raw = BigInt(quote.outAmount);
    const tokens = Number(raw) / 10 ** decimals;
    const f: Fill = { agent: ctx.agent, side: "buy", mint, sol, tokens, priceSol: tokens > 0 ? sol / tokens : q.priceSol, ts: ctx.now, sig, reason: ctx.reason };
    this.o.ledger.applyBuy(f, { raw, decimals });
    return f;
  }

  async sell(ctx: OrderContext, mint: string, fraction: number, q: Quote): Promise<Fill | null> {
    const p = this.o.ledger.book(ctx.agent).positions.get(mint);
    if (!p?.raw) return null;
    let raw = fraction >= 0.999 ? p.raw : (p.raw * BigInt(Math.round(fraction * 10_000))) / 10_000n;
    // Never try to sell more than the wallet actually holds.
    const onChain = await this.tokenBalance(ctx.agent, mint);
    if (raw > onChain) raw = onChain;
    if (raw <= 0n) return null;
    const quote = await this.quote(mint, SOL_MINT, raw);
    const sig = await this.swap(ctx.agent, quote);
    const sol = Number(BigInt(quote.outAmount)) / 1e9;
    const tokens = Number(raw) / 10 ** (p.decimals ?? q.decimals ?? 6);
    const f: Fill = { agent: ctx.agent, side: "sell", mint, sol, tokens, priceSol: tokens > 0 ? sol / tokens : q.priceSol, ts: ctx.now, sig, reason: ctx.reason };
    this.o.ledger.applySell(f, raw >= p.raw ? 1 : fraction, raw);
    return f;
  }

  /** The agent's own signer. There is no shared or fallback wallet. */
  signerFor(agent: string): KeyPairSigner {
    const w = this.o.wallets.get(agent);
    if (!w) throw new Error(`no wallet loaded for agent ${agent}`);
    return w;
  }

  private async quote(inputMint: string, outputMint: string, amount: bigint): Promise<JupQuote> {
    const u = `${this.o.jupiterUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.o.slippageBps}`;
    const res = await this.fetcher(u);
    if (!res.ok) throw new Error(`jupiter quote ${res.status}: ${await res.text()}`);
    return (await res.json()) as JupQuote;
  }

  private async swap(agent: string, quoteResponse: JupQuote): Promise<string> {
    const signer = this.signerFor(agent);
    const res = await this.fetcher(`${this.o.jupiterUrl}/swap/v1/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: signer.address,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: this.o.maxPriorityLamports ?? 200_000, priorityLevel: "high" } },
      }),
    });
    if (!res.ok) throw new Error(`jupiter swap ${res.status}: ${await res.text()}`);
    const { swapTransaction } = (await res.json()) as { swapTransaction: string };
    const tx = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(swapTransaction)));
    const signed = await signTransaction([signer.keyPair], tx);
    const sig = await this.rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", skipPreflight: false, maxRetries: 3n }).send();
    await this.confirm(sig);
    return sig;
  }

  private async confirm(sig: Signature, timeoutMs = 60_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const { value } = await this.rpc.getSignatureStatuses([sig]).send();
      const s = value[0];
      if (s?.err) throw new Error(`swap ${sig} failed on chain`);
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
      await new Promise((r) => setTimeout(r, 800));
    }
    throw new Error(`swap ${sig} did not confirm in time`);
  }

  private async tokenBalance(agent: string, mint: string): Promise<bigint> {
    const owner = this.signerFor(agent).address;
    const { value } = await this.rpc.getTokenAccountsByOwner(owner, { mint: address(mint) }, { encoding: "jsonParsed" }).send();
    let total = 0n;
    for (const a of value) {
      const amt = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
      if (amt) total += BigInt(amt);
    }
    return total;
  }
}
