// CLI: pnpm start -- --config swarm.json [--ticks N]
//      pnpm start -- --config swarm.json --wallets   (create missing agent wallets, list addresses and balances)
//      pnpm start -- --roster        (list deployable roster agents)
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { liveArmed, loadConfig, type SwarmConfig } from "./config";
import { AgentChainFeed, JupiterFeed, SimFeed, type PriceFeed } from "./feeds";
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

  const swarm = new Swarm(cfg, specs, {
    feed: feedFor(cfg),
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
  process.once("SIGINT", () => swarm.stop("SIGINT"));
  process.once("SIGTERM", () => swarm.stop("SIGTERM"));
  const ticks = arg("ticks");
  await swarm.run(ticks ? Number(ticks) : undefined);
}

main().catch((e) => {
  console.error(`[swarm] ${(e as Error).message}`);
  process.exit(1);
});
