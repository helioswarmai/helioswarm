// CLI: pnpm start -- --config swarm.json [--ticks N]
//      pnpm start -- --config swarm.json --wallets   (create missing agent wallets, list addresses and balances)
//      pnpm start -- --config swarm.json --watch     (stream on-chain flows and signals only, no trading)
//      pnpm start -- --roster        (list deployable roster agents)
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { liveArmed, loadConfig, type SwarmConfig } from "./config";
import type { Signal } from "./board";
import { AgentChainFeed, JupiterFeed, LiveFeed, SimFeed, type PriceFeed } from "./feeds";
import { snapshotHolders } from "./stream/holders";
import { parseTx } from "./stream/parse";
import { decodePending, learnTokenAccounts, TokenAccountIndex } from "./stream/pending";
import { SignalEngine } from "./stream/signals";
import { expandGroups, loadRoster } from "./roster";
import { Swarm } from "./swarm";
import { JupiterVenue, PaperVenue } from "./venues";
import { ensureWallets, loadWallets, solBalances, walletPath } from "./wallets";
import type { KeyPairSigner } from "@solana/kit";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function feedFor(cfg: SwarmConfig): PriceFeed {
  switch (cfg.feed.kind) {
    case "agentchain":
      return new AgentChainFeed(cfg.feed.engineUrl!);
    case "jupiter":
      return new JupiterFeed(cfg.feed.jupiterUrl ?? cfg.live.jupiterUrl);
    default:
      return new SimFeed(cfg.feed.seed ?? 1);
  }
}

/** Starts the SVS stream feeding a SignalEngine. Returns a stop function. */
async function startStream(
  cfg: SwarmConfig,
  mints: string[],
  rpcUrl: string | undefined,
  post: (s: Signal) => void,
  opts: { ourWallets?: Set<string>; onFlow?: (line: Record<string, unknown>) => void; feed?: LiveFeed } = {},
): Promise<() => void> {
  const sc = cfg.stream!;
  const engine = new SignalEngine(mints, post, cfg.signals, opts.ourWallets);
  const index = new TokenAccountIndex();
  if (sc.snapshot) {
    if (!rpcUrl) console.warn("[stream] no SOLANA_RPC_URL: skipping the holder snapshot, shares use tracked balances until supply is known.");
    else
      for (const book of engine.books.values()) {
        await snapshotHolders(rpcUrl, book, Date.now(), index).catch((e) => console.warn(`[stream] snapshot ${book.mint}: ${(e as Error).message}`));
        console.warn(`[stream] ${book.mint}: supply ${book.supplyRaw ?? "?"}, ${book.holders.size} top holders loaded`);
      }
  }
  const { SvsStream, DeshredStream } = await import("./stream/svs");
  const stream = new SvsStream(sc, mints);
  const targets = new Set(mints);
  stream.on("status", (m: string) => console.warn(`[stream] ${m}`));
  stream.on("error", (e: Error) => console.warn(`[stream] error: ${e.message}`));
  stream.on("tx", (tx) => {
    learnTokenAccounts(tx, targets, index);
    const parsed = parseTx(tx, targets);
    const early = engine.seenEarly(tx.signature, tx.ts);
    for (const f of parsed.flows) {
      if (f.priceSol) opts.feed?.observe(f.mint, f.priceSol, f.ts, f.decimals);
      opts.onFlow?.({ ts: new Date(f.ts).toISOString(), event: "flow", kind: f.kind, mint: f.mint, owner: f.owner, tokens: f.tokens, sol: +f.sol.toFixed(6), priceSol: f.priceSol, sig: f.signature, ...(f.counterparty ? { counterparty: f.counterparty } : {}), ...(early != null ? { seenEarlyMs: early } : {}) });
    }
    engine.ingest(parsed);
  });
  await stream.start();

  let deshred: InstanceType<typeof DeshredStream> | null = null;
  let refresh: NodeJS.Timeout | undefined;
  if (sc.deshred) {
    // Watch the mints plus the top holders' wallets and token accounts, so transfers
    // and swaps that never name the mint (plain SPL transfers, Raydium v4) are still caught.
    const filter = () => {
      const wallets = engine.topHolderWallets(sc.deshredHolders);
      const accs = mints.flatMap((m) => index.accountsOf(m, wallets));
      return [...mints, ...wallets, ...accs].slice(0, 1_000);
    };
    deshred = new DeshredStream(sc, filter());
    deshred.on("status", (m: string) => console.warn(`[stream] ${m}`));
    deshred.on("error", (e: Error) => console.warn(`[stream] error: ${e.message}`));
    deshred.on("pending", (tx) => {
      const intents = decodePending(tx, targets, index);
      for (const i of intents) opts.onFlow?.({ ts: new Date(i.ts).toISOString(), event: "pending", kind: i.kind, mint: i.mint, owner: i.owner, venue: i.venue, amountRaw: i.amountRaw?.toString(), to: i.to, sig: i.signature });
      engine.ingestPending(intents);
    });
    await deshred.start();
    refresh = setInterval(() => deshred!.setAccounts(filter()), 60_000);
    refresh.unref();
  }
  return () => {
    stream.stop();
    deshred?.stop();
    if (refresh) clearInterval(refresh);
  };
}

async function main() {
  if (process.argv.includes("--roster")) {
    for (const r of loadRoster()) console.log(`${r.name.padEnd(24)} ${(r.preset ?? "?").padEnd(10)} ${r.persona.slice(0, 90)}`);
    return;
  }
  const path = resolve(arg("config") ?? "swarm.json");
  const cfg = loadConfig(path);
  for (const p of cfg.plugins) await import(pathToFileURL(resolve(dirname(path), p)).href);
  const specs = expandGroups(cfg.groups);
  const walletsDir = resolve(dirname(path), cfg.walletsDir);
  const rpcUrl = cfg.live.rpcUrl ?? process.env.SOLANA_RPC_URL;

  if (process.argv.includes("--wallets")) {
    const ids = specs.map((s) => s.id);
    const created = ensureWallets(walletsDir, ids);
    const wallets = await loadWallets(walletsDir, ids);
    const balances = rpcUrl ? await solBalances(rpcUrl, wallets) : null;
    console.log(`${specs.length} agents, wallets in ${walletsDir}${created.length ? ` (${created.length} new)` : ""}`);
    for (const s of specs) {
      const bal = balances ? `${balances.get(s.id)!.toFixed(4).padStart(10)} SOL` : "";
      console.log(`${s.id.padEnd(24)} ${wallets.get(s.id)!.address.padEnd(44)} bankroll ${String(s.bankrollSol).padStart(6)} ${bal}${created.includes(s.id) ? "  new" : ""}`);
    }
    if (!balances) console.log("Set SOLANA_RPC_URL to see balances.");
    console.log(`Fund each wallet with its bankroll plus ${cfg.feeReserveSol} SOL for fees. Back up ${walletsDir}: it holds the private keys.`);
    return;
  }

  if (process.argv.includes("--watch")) {
    if (!cfg.stream) throw new Error('--watch needs a "stream" section in the config');
    const mints = [...new Set(specs.flatMap((s) => s.targets.map((t) => t.mint)))];
    const stop = await startStream(cfg, mints, rpcUrl, (s) => console.log(JSON.stringify({ event: "signal", ...s, ts: new Date(s.ts).toISOString() })), { onFlow: (l) => console.log(JSON.stringify(l)) });
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
    stop();
    return;
  }

  const live = liveArmed(cfg);
  if (cfg.mode === "live" && !live) console.warn("[swarm] config says live but SWARM_LIVE=1 is not set: running on paper.");

  let wallets = new Map<string, KeyPairSigner>();
  let balances = new Map<string, number>();
  if (live) {
    if (!rpcUrl) throw new Error("live mode needs live.rpcUrl in the config or SOLANA_RPC_URL");
    wallets = await loadWallets(walletsDir, specs.map((s) => s.id));
    balances = await solBalances(rpcUrl, wallets);
    console.warn(`[swarm] LIVE: ${specs.length} agents, each trading from its own wallet. Spend ceiling ${cfg.risk.maxSwarmSpendSol} SOL. Create ${cfg.killFile} to stop.`);
    cfg.live.rpcUrl = rpcUrl;
  }

  const liveFeed = cfg.stream ? new LiveFeed(feedFor(cfg)) : null;
  const swarm = new Swarm(cfg, specs, {
    feed: liveFeed ?? feedFor(cfg),
    venue: (ledger) =>
      live
        ? new JupiterVenue({ ledger, rpcUrl: cfg.live.rpcUrl!, jupiterUrl: cfg.live.jupiterUrl, slippageBps: cfg.risk.slippageBps, wallets })
        : new PaperVenue(ledger, cfg.risk.slippageBps, cfg.risk.feeBps),
  });
  if (live) {
    // An agent can only spend what its own wallet holds, less the fee reserve.
    for (const s of specs) {
      const bal = balances.get(s.id) ?? 0;
      const cash = Math.max(0, Math.min(s.bankrollSol, bal - cfg.feeReserveSol));
      const book = swarm.ledger.book(s.id);
      book.cashSol = cash;
      book.startSol = cash;
      swarm.log("wallet", { agent: s.id, address: wallets.get(s.id)!.address, balanceSol: bal, tradableSol: cash, file: walletPath(walletsDir, s.id) });
      if (cash <= 0) console.warn(`[swarm] ${s.id} has ${bal} SOL in ${wallets.get(s.id)!.address}: below the fee reserve, it will not buy.`);
    }
  }
  let stopStream = () => {};
  if (cfg.stream) {
    const ourWallets = new Set([...wallets.values()].map((w) => w.address as string));
    stopStream = await startStream(cfg, swarm.mints, rpcUrl, (s) => swarm.board.post(s), { ourWallets, feed: liveFeed!, onFlow: process.env.SWARM_LOG_FLOWS === "1" ? (l) => swarm.log("flow", l) : undefined });
  }
  process.once("SIGINT", () => swarm.stop("SIGINT"));
  process.once("SIGTERM", () => swarm.stop("SIGTERM"));
  const ticks = arg("ticks");
  await swarm.run(ticks ? Number(ticks) : undefined);
  stopStream();
}

main().catch((e) => {
  console.error(`[swarm] ${(e as Error).message}`);
  process.exit(1);
});
