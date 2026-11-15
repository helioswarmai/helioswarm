# Agent Swarm

Deploy a swarm of AgentChain agents that trade chosen token contracts on Solana and run other jobs alongside. Agents come from the engine's roster (`data/sim-agents.json`, copied from AgentChain, persona, traits and rules included) or are stamped out from a psychology preset (`degen`, `momentum`, `holder`, `contrarian`, `sniper`, `showman`) as many times as you like.

**Paper trading is the default.** Real swaps happen only when the config says `"mode": "live"` *and* the environment has `SWARM_LIVE=1`, and every agent trades from its own wallet: one keypair file per agent in `wallets/`. Keys never go in the config.

## Run it

```sh
cp swarm.example.json swarm.json # edit targets, groups, risk
pnpm start -- --config swarm.json
pnpm start -- --config swarm.json --ticks 50   # a bounded run
pnpm start -- --config swarm.json --wallets   # create/list one wallet per agent
pnpm start -- --roster                               # list roster agents
```

Every event (fill, refused order, alert, report, summary) is a JSON line on stdout and in `logFile`. Create the `killFile` (default `SWARM_STOP`) or press Ctrl-C to stop; a final summary with each agent's equity and P&L is printed on the way out.

## Config

| Key | Default | |
|---|---|---|
| `mode` | `paper` | `live` sends real swaps through Jupiter, but only with `SWARM_LIVE=1` |
| `tickMs` | `15000` | How often prices refresh and every agent runs its tasks |
| `feed.kind` | `sim` | `sim` (offline random walk), `jupiter` (any Solana token, Jupiter Price API), `agentchain` (AgentChain coins from an engine, needs `feed.engineUrl`) |
| `risk.maxBuySol` | `0.05` | Largest single buy |
| `risk.maxSwarmSpendSol` | `1` | Total SOL the whole swarm may spend on buys |
| `risk.maxTxPerMin` | `10` | Orders per minute across the swarm |
| `risk.slippageBps` | `300` | Swap slippage (live) and paper fill slippage |
| `risk.feeBps` | `100` | Paper fee per trade |
| `live.rpcUrl` | `SOLANA_RPC_URL` | RPC for sending swaps and reading balances |
| `live.jupiterUrl` | `https://lite-api.jup.ag` | Jupiter API base |
| `walletsDir` | `wallets` | Folder of per-agent keypair files, relative to the config file |
| `feeReserveSol` | `0.01` | SOL each live wallet keeps back for fees and token-account rent |
| `plugins` | `[]` | Modules that call `registerTask()` to add task types |
| `groups` | | See below |

Each group:

| Key | |
|---|---|
| `roster` | Roster agent names to deploy as they are |
| `preset`, `count`, `namePrefix`, `persona` | Or a preset deployed `count` times |
| `bankrollSol` | Each agent's budget (paper cash, or in live mode a cap on what it spends from its own wallet) |
| `targets` | Token mints the agents may trade, as strings or `{ mint, symbol }` |
| `tasks` | Task names run each tick, in order (default `["trade"]`) |
| `rules` | AgentChain trading rules: `takeProfitPct`, `stopLossPct`, `sellAfterMin`, `maxSolPerCoin`, `maxCoins` |
| `brain` | `traits` (no model, reads the psychology) or `claude` (asks a model with the persona, falls back to `traits`) |
| `taskOptions` | Per-task settings, e.g. `{ "watch": { "alertPct": 5, "webhook": "https://..." } }` |

The `claude` brain reads `ANTHROPIC_API_KEY` and `SWARM_MODEL` (default `claude-haiku-5-5`).

## Tasks

- `trade`: sponsor rules first (take profit, stop loss, time exit), then the brain decides buy, sell or hold.
- `watch`: logs an `alert` (and POSTs to `webhook` if set) when a target moves `alertPct` since the last alert.
- `report`: logs equity and P&L every `every` ticks (default 20).

Add your own:

```ts
// my-task.ts, listed in "plugins"
import { registerTask } from "agent-swarm";
registerTask("snapshot", () => ({
  name: "snapshot",
  async run(ctx) {
    ctx.log("snapshot", { cash: ctx.book.cashSol, open: ctx.book.positions.size });
  },
}));
```

A task gets the agent, its book, the price feed, its brain, per-task options and state, and `ctx.buy` / `ctx.sell`, which go through the swarm's guard rails (per-buy cap, agent cash, per-coin rules, swarm spend ceiling, transaction rate).

## Wallets: one per agent

Every agent has its own Solana wallet and signs its own swaps. No wallet is shared, so on chain each agent is a separate buyer.

```sh
pnpm start -- --config swarm.json --wallets
```

This creates a keypair file for every agent in the config that doesn't have one yet (`wallets/<agent id>.json`, solana-keygen format, mode 600). It then lists each agent's address and bankroll, plus its SOL balance when `SOLANA_RPC_URL` is set. Run it again after adding agents: existing files are never overwritten. The folder holds private keys. It is gitignored, so back it up yourself, because deleting a file loses whatever that wallet holds. Set `walletsDir` to keep the folder somewhere else; the path is relative to the config file.

When a live run starts, each agent's spendable cash is the lower of its `bankrollSol` and its wallet's real SOL balance minus `feeReserveSol` (default 0.01 SOL, kept back for fees and token-account rent). An agent whose wallet is empty logs a warning and doesn't buy. A missing wallet file, or two agents on the same key, stops the run before it trades.

## Going live

1. `pnpm start -- --config swarm.json --wallets`, then send each listed address its bankroll plus the fee reserve.
2. Set `"mode": "live"` and a tight `risk.maxSwarmSpendSol`.
3. `SWARM_LIVE=1 SOLANA_RPC_URL=... pnpm start -- --config swarm.json`

Without `SWARM_LIVE=1` a live config runs on paper and says so.

## Limits of this first cut

- Live fills are booked at Jupiter's quoted amount, not parsed from the landed transaction; sells are capped at the wallet's real token balance.
- The swarm keeps its books in memory, so a restart starts every agent fresh (positions in a live wallet stay put; sell them by hand or with a new run's agents).
- Trading AgentChain coins live still goes through the engine's own runtime (`ENGINE_ROLE=runtime`); here the `agentchain` feed is for paper runs, and graduated coins can be traded live through Jupiter.
