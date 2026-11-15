// CLI: pnpm start -- --config swarm.json [--ticks N]
//      pnpm start -- --roster        (list deployable roster agents)
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { liveArmed, loadConfig, type SwarmConfig } from "./config";
import { AgentChainFeed, JupiterFeed, SimFeed, type PriceFeed } from "./feeds";
import { expandGroups, loadRoster } from "./roster";
import { Swarm } from "./swarm";
import { JupiterVenue, loadKeypairFile, PaperVenue } from "./venues";
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
  const live = liveArmed(cfg);
  if (cfg.mode === "live" && !live) console.warn("[swarm] config says live but SWARM_LIVE=1 is not set: running on paper.");

  let wallets = new Map<number, KeyPairSigner>();
  if (live) {
    const rpcUrl = cfg.live.rpcUrl ?? process.env.SOLANA_RPC_URL;
    if (!rpcUrl) throw new Error("live mode needs live.rpcUrl in the config or SOLANA_RPC_URL");
    for (const [i, g] of cfg.groups.entries()) {
      const file = process.env[g.walletEnv!];
      if (!file) throw new Error(`groups[${i}]: env var ${g.walletEnv} (keypair file path) is not set`);
      wallets.set(i, await loadKeypairFile(file));
    }
    console.warn(`[swarm] LIVE: ${specs.length} agents will send real swaps. Spend ceiling ${cfg.risk.maxSwarmSpendSol} SOL. Create ${cfg.killFile} to stop.`);
    cfg.live.rpcUrl = rpcUrl;
  }

  const swarm = new Swarm(cfg, specs, {
    feed: feedFor(cfg),
    venue: (ledger) =>
      live
        ? new JupiterVenue({ ledger, rpcUrl: cfg.live.rpcUrl!, jupiterUrl: cfg.live.jupiterUrl, slippageBps: cfg.risk.slippageBps, wallets })
        : new PaperVenue(ledger, cfg.risk.slippageBps, cfg.risk.feeBps),
  });
  process.once("SIGINT", () => swarm.stop("SIGINT"));
  process.once("SIGTERM", () => swarm.stop("SIGTERM"));
  const ticks = arg("ticks");
  await swarm.run(ticks ? Number(ticks) : undefined);
}

main().catch((e) => {
  console.error(`[swarm] ${(e as Error).message}`);
  process.exit(1);
});
