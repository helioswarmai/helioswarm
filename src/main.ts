// CLI: pnpm start -- --config swarm.json [--ticks N]
//      pnpm start -- --config swarm.json --wallets   (create missing agent wallets, list addresses and balances)
//      pnpm start -- --config swarm.json --watch     (stream on-chain flows and signals only, no trading)
//      pnpm start -- --roster        (list deployable roster agents)
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { liveArmed, loadConfig, type SwarmConfig } from "./config";
import type { Signal } from "./board";
import { HelioSwarmFeed, JupiterFeed, LiveFeed, SimFeed, type PriceFeed } from "./feeds";
import { snapshotHolders } from "./stream/holders";
import { parseTx } from "./stream/parse";
import { decodePending, learnTokenAccounts, TokenAccountIndex } from "./stream/pending";
import { SignalEngine } from "./stream/signals";
import { balanceLamports, distribute, ensureFundingWallet, fundingNeeded, LAMPORTS, planTopups, sweep, waitForDeposit } from "./funding";
import { Dashboard } from "./dashboard";
import { PrettyWatch } from "./pretty";
import { prettyRunLine } from "./pretty-run";
import { expandGroups, loadRoster } from "./roster";
import { Swarm } from "./swarm";
import { JupiterVenue, PaperVenue } from "./venues";
import { ensureWallets, loadWallets, solBalances, walletPath } from "./wallets";
import type { KeyPairSigner } from "@solana/kit";

/** Shows paths under the home folder as ~/... so the username is not printed. */
const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** With JUPITER_API_KEY set, Jupiter calls go to api.jup.ag with the key (higher rate limits than lite-api). */
const JUP_KEY = process.env.JUPITER_API_KEY;
const jupFetch: typeof fetch = JUP_KEY
  ? (input, init = {}) => fetch(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "x-api-key": JUP_KEY } })
  : fetch;
const jupUrl = (u?: string) => (JUP_KEY ? "https://api.jup.ag" : (u ?? "https://lite-api.jup.ag"));

/** --dashboard [port]: serve the live demo page (default port 4545). */
function dashboardPort(): number | null {
  const i = process.argv.indexOf("--dashboard");
  if (i < 0) return null;
  const n = Number(process.argv[i + 1]);
  if (Number.isInteger(n) && n > 0) return n;
  return process.env.PORT ? Number(process.env.PORT) : 4545;
}

function feedFor(cfg: SwarmConfig): PriceFeed {
  switch (cfg.feed.kind) {
    case "helioswarm":
      return new HelioSwarmFeed(cfg.feed.engineUrl!);
    case "jupiter":
      return new JupiterFeed(jupUrl(cfg.feed.jupiterUrl ?? cfg.live.jupiterUrl), jupFetch);
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
  opts: { ourWallets?: Set<string>; onFlow?: (line: Record<string, unknown>) => void; feed?: LiveFeed; onStatus?: (msg: string) => void; onEngine?: (e: SignalEngine) => void } = {},
): Promise<() => void> {
  const sc = cfg.stream!;
  const engine = new SignalEngine(mints, post, cfg.signals, opts.ourWallets);
  const index = new TokenAccountIndex();
  opts.onEngine?.(engine);
  const say = opts.onStatus ?? ((m: string) => console.warn(`[stream] ${m}`));
  if (sc.snapshot) {
    if (!rpcUrl) say("no SOLANA_RPC_URL: skipping the holder snapshot, shares use tracked balances until supply is known.");
    else
      for (const book of engine.books.values()) {
        await snapshotHolders(rpcUrl, book, Date.now(), index).catch((e) => say(`holder snapshot for ${book.mint} failed: ${(e as Error).message.trim()}`));
        say(`${book.mint}: supply ${book.supplyRaw != null ? (Number(book.supplyRaw) / 10 ** book.decimals).toLocaleString() : "?"}, ${book.holders.size} top holders loaded`);
      }
  }
  const { SvsStream, DeshredStream } = await import("./stream/svs");
  const stream = new SvsStream(sc, mints);
  const targets = new Set(mints);
  stream.on("status", (m: string) => say(m));
  stream.on("error", (e: Error) => say(`error: ${e.message}`));
  stream.on("tx", (tx) => {
    learnTokenAccounts(tx, targets, index);
    const parsed = parseTx(tx, targets);
    const early = engine.seenEarly(tx.signature, Date.now()); // both sides on local arrival time
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
    deshred.on("status", (m: string) => say(m));
    deshred.on("error", (e: Error) => say(`error: ${e.message}`));
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

  if (process.argv.includes("--fund") || process.argv.includes("--sweep")) {
    if (!rpcUrl) throw new Error("--fund and --sweep need SOLANA_RPC_URL (or live.rpcUrl in the config)");
    const ids = specs.map((s) => s.id);
    ensureWallets(walletsDir, ids);
    const wallets = await loadWallets(walletsDir, ids);
    const { signer: funder } = await ensureFundingWallet(walletsDir);
    const fmt = (l: bigint) => `${(Number(l) / LAMPORTS).toFixed(4)} SOL`;
    if (process.argv.includes("--sweep")) {
      const done = await sweep(rpcUrl, wallets, funder.address);
      for (const d of done) console.log(`${d.id.padEnd(24)} sent ${fmt(d.lamports)} back   ${d.sig}`);
      console.log(done.length ? `Swept to the funding wallet ${funder.address}: now ${fmt(await balanceLamports(rpcUrl, funder.address))}. Tokens the agents still hold were not moved.` : "Nothing to sweep: every agent wallet is empty.");
      return;
    }
    const balances = await solBalances(rpcUrl, wallets);
    const topups = planTopups(specs.map((s) => ({ id: s.id, address: wallets.get(s.id)!.address, targetSol: s.bankrollSol + cfg.feeReserveSol, balanceSol: balances.get(s.id)! })));
    if (!topups.length) return console.log("Every agent wallet already holds its bankroll plus the fee reserve. Nothing to send.");
    const need = fundingNeeded(topups);
    console.log(`Funding wallet: ${funder.address}`);
    for (const t of topups) console.log(`  ${t.id.padEnd(24)} needs ${fmt(t.lamports)}`);
    let have = await balanceLamports(rpcUrl, funder.address);
    if (have < need) {
      if (!process.argv.includes("--wait")) {
        console.log(`It holds ${fmt(have)} and needs ${fmt(need)} (including fees). Send ${fmt(need - have)} to ${funder.address}, then run --fund again, or run --fund --wait to send automatically when it arrives.`);
        return;
      }
      console.log(`Waiting for ${fmt(need - have)} more at ${funder.address} ... (Ctrl+C to cancel)`);
      have = await waitForDeposit(rpcUrl, funder.address, need, (h) => process.stdout.write(`\r  holds ${fmt(h)} of ${fmt(need)}   `));
      console.log("");
    }
    const sigs = await distribute(rpcUrl, funder, topups);
    console.log(`Sent ${fmt(need)} to ${topups.length} agents in ${sigs.length} transaction${sigs.length > 1 ? "s" : ""}:`);
    for (const sig of sigs) console.log(`  https://solscan.io/tx/${sig}`);
    console.log(`Funding wallet left with ${fmt(await balanceLamports(rpcUrl, funder.address))}.`);
    return;
  }

  if (process.argv.includes("--wallets")) {
    const ids = specs.map((s) => s.id);
    const created = ensureWallets(walletsDir, ids);
    const wallets = await loadWallets(walletsDir, ids);
    const balances = rpcUrl ? await solBalances(rpcUrl, wallets) : null;
    console.log(`${specs.length} agents, wallets in ${tilde(walletsDir)}${created.length ? ` (${created.length} new)` : ""}`);
    for (const s of specs) {
      const bal = balances ? `${balances.get(s.id)!.toFixed(4).padStart(10)} SOL` : "";
      console.log(`${s.id.padEnd(24)} ${wallets.get(s.id)!.address.padEnd(44)} bankroll ${String(s.bankrollSol).padStart(6)} ${bal}${created.includes(s.id) ? "  new" : ""}`);
    }
    const { signer: funder, created: fNew } = await ensureFundingWallet(walletsDir);
    const fBal = rpcUrl ? `${(Number(await balanceLamports(rpcUrl, funder.address)) / LAMPORTS).toFixed(4).padStart(10)} SOL` : "";
    console.log(`${"funding wallet".padEnd(24)} ${funder.address.padEnd(44)} ${" ".repeat(15)}${fBal}${fNew ? "  new" : ""}`);
    if (!balances) console.log("Set SOLANA_RPC_URL to see balances.");
    console.log(`Send SOL to the funding wallet, then run --fund to give each agent its bankroll plus ${cfg.feeReserveSol} SOL for fees (--fund --wait sends as soon as it arrives). Back up ${tilde(walletsDir)}: it holds the private keys.`);
    return;
  }

  if (process.argv.includes("--watch")) {
    if (!cfg.stream) throw new Error('--watch needs a "stream" section in the config');
    const mints = [...new Set(specs.flatMap((s) => s.targets.map((t) => t.mint)))];
    let stop: () => void;
    if (process.argv.includes("--json")) {
      stop = await startStream(cfg, mints, rpcUrl, (s) => console.log(JSON.stringify({ event: "signal", ...s, ts: new Date(s.ts).toISOString() })), { onFlow: (l) => console.log(JSON.stringify(l)) });
    } else {
      const symbols = new Map(specs.flatMap((s) => s.targets.map((t) => [t.mint, t.symbol ?? ""] as const)).filter(([, sym]) => sym));
      let engine: SignalEngine | undefined;
      const top = Number(arg("top") ?? 0);
      if (!Number.isInteger(top) || top < 0) throw new Error("--top must be a whole number, e.g. --top 10");
      // --agents: only your agent wallets, read straight from the chain (works while a live run trades elsewhere).
      const onlyAgents = process.argv.includes("--agents");
      // Addresses come from the wallet files when they are here, otherwise from agents.json next to the
      // config ({"agent id": "address"}), so a hosted dashboard needs no private keys.
      const publicFile = resolve(dirname(path), "agents.json");
      const agentWallets = new Map<string, { address: string }>();
      if (onlyAgents) {
        const ids = specs.map((s) => s.id);
        if (ids.every((id) => existsSync(walletPath(walletsDir, id)))) for (const [id, w] of await loadWallets(walletsDir, ids)) agentWallets.set(id, { address: w.address });
        else if (existsSync(publicFile)) for (const [id, a] of Object.entries(JSON.parse(readFileSync(publicFile, "utf8")) as Record<string, string>)) agentWallets.set(id, { address: a });
        else throw new Error(`--agents needs the wallet files in ${tilde(walletsDir)} or an agents.json of public addresses next to the config`);
        const missing = ids.filter((id) => !agentWallets.has(id));
        if (missing.length) throw new Error(`no address for ${missing.join(", ")}`);
      }
      const byAddress = new Map([...agentWallets].map(([id, w]) => [w.address as string, id]));
      const view = new PrettyWatch(symbols, (m) => engine?.books.get(m)?.decimals ?? 6, top, onlyAgents ? byAddress : undefined);
      view.header(mints);
      const port = dashboardPort();
      const dash = port
        ? new Dashboard({ title: "HelioSwarm", mode: onlyAgents ? "live" : "watch", tokens: mints.map((m) => ({ mint: m, symbol: symbols.get(m) ?? "" })), agents: onlyAgents ? specs.map((s) => ({ id: s.id, preset: s.preset, wallet: agentWallets.get(s.id)!.address, bankrollSol: s.bankrollSol })) : [] }, port)
        : null;
      if (onlyAgents && rpcUrl) {
        const bal = await solBalances(rpcUrl, agentWallets as unknown as Map<string, KeyPairSigner>);
        for (const s of specs) {
          const b = bal.get(s.id) ?? 0;
          view.status(`${s.id.padEnd(14)} ${agentWallets.get(s.id)!.address}  ${b.toFixed(4)} SOL`);
          dash?.push({ event: "wallet", agent: s.id, address: agentWallets.get(s.id)!.address, balanceSol: b, tradableSol: b });
        }
      }
      if (dash && rpcUrl) {
        // Recent trades from the chain, so the chart and feed have history from the first visit.
        const { backfillFlows } = await import("./backfill");
        void backfillFlows(rpcUrl, mints)
          .then((flows) => {
            const lines: Record<string, unknown>[] = [];
            for (const l of flows) {
              const agent = byAddress.get(String(l.owner));
              if (agent) lines.push({ ts: l.ts, event: "fill", agent, side: l.kind, mint: l.mint, sol: l.sol, tokens: l.tokens, priceSol: l.priceSol, sig: l.sig, reason: "on-chain" });
              lines.push(l);
            }
            view.status(`dashboard: ${dash.seed(lines)} past trades loaded from chain`);
          })
          .catch((e) => view.status(`dashboard: trade backfill failed: ${(e as Error).message}`));
      }
      const stopStream = await startStream(cfg, mints, rpcUrl, (s) => (view.signal(s), dash?.push({ event: "signal", ...s })), {
        onFlow: (l) => {
          view.event(l);
          if (!dash) return;
          const agent = byAddress.get(String(l.owner));
          // Our agents' on-chain trades become fills so the dashboard cards update.
          if (agent && (l.kind === "buy" || l.kind === "sell")) dash.push({ event: "fill", agent, side: l.kind, mint: l.mint, sol: l.sol, tokens: l.tokens, priceSol: l.priceSol, sig: l.sig, reason: "on-chain" });
          dash.push(l);
        },
        onStatus: (m) => view.status(m),
        onEngine: (e) => (engine = e),
      });
      stop = () => (stopStream(), view.stop(), dash?.close());
    }
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
    console.warn(`[swarm] LIVE: ${specs.length} agents, each trading from its own wallet. ${Number.isFinite(cfg.risk.maxSwarmSpendSol) ? `Spend ceiling ${cfg.risk.maxSwarmSpendSol} SOL.` : "No spend cap: agents trade what their wallets hold."} Create ${cfg.killFile} to stop.`);
    cfg.live.rpcUrl = rpcUrl;
  }

  const liveFeed = cfg.stream ? new LiveFeed(feedFor(cfg)) : null;
  const runSymbols = new Map(specs.flatMap((s) => s.targets.map((t) => [t.mint, t.symbol ?? ""] as const)).filter(([, sym]) => sym));
  const port = dashboardPort();
  const dash = port
    ? new Dashboard({ title: "HelioSwarm", mode: live ? "live" : "paper", tokens: [...new Set(specs.flatMap((s) => s.targets.map((t) => t.mint)))].map((m) => ({ mint: m, symbol: runSymbols.get(m) ?? "" })), agents: specs.map((s) => ({ id: s.id, preset: s.preset, wallet: wallets.get(s.id)?.address, bankrollSol: s.bankrollSol })) }, port)
    : null;
  const print = process.argv.includes("--json") ? (l: Record<string, unknown>) => console.log(JSON.stringify(l)) : prettyRunLine(runSymbols);
  const swarm = new Swarm(cfg, specs, {
    emit: (l) => (print(l), dash?.push(l)),
    feed: liveFeed ?? feedFor(cfg),
    venue: (ledger) =>
      live
        ? new JupiterVenue({ ledger, rpcUrl: cfg.live.rpcUrl!, jupiterUrl: jupUrl(cfg.live.jupiterUrl), slippageBps: cfg.risk.slippageBps, wallets, fetcher: jupFetch })
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
    stopStream = await startStream(cfg, swarm.mints, rpcUrl, (s) => swarm.board.post(s), { ourWallets, feed: liveFeed!, onFlow: (l) => {
        if (process.env.SWARM_LOG_FLOWS === "1") swarm.log("flow", l);
        else dash?.push(l);
      } });
  }
  process.once("SIGINT", () => swarm.stop("SIGINT"));
  process.once("SIGTERM", () => swarm.stop("SIGTERM"));
  const ticks = arg("ticks");
  await swarm.run(ticks ? Number(ticks) : undefined);
  stopStream();
  dash?.close();
}

main().catch((e) => {
  console.error(`[swarm] ${tilde((e as Error).message.split(homedir()).join("~"))}`);
  process.exit(1);
});
