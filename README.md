# Agent Swarm

Deploy a swarm of AgentChain agents that trade chosen token contracts on Solana and run other jobs alongside. Agents come from the engine's roster (`data/sim-agents.json`, copied from AgentChain, persona, traits and rules included) or are stamped out from a psychology preset (`degen`, `momentum`, `holder`, `contrarian`, `sniper`, `showman`) as many times as you like.

**Paper trading is the default.** Real swaps happen only when the config says `"mode": "live"` *and* the environment has `SWARM_LIVE=1`, and every agent trades from its own wallet: one keypair file per agent in `wallets/`. Keys never go in the config.

## Run it

```sh
cp swarm.example.json swarm.json # edit targets, groups, risk
pnpm start -- --config swarm.json
pnpm start -- --config swarm.json --ticks 50   # a bounded run
pnpm start -- --config swarm.json --wallets   # create/list one wallet per agent
pnpm start -- --config swarm.json --watch     # stream on-chain flows and signals only
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
| `coordination` | see below | How agents share the board |
| `stream` | off | Real-time on-chain data from SVS, see below |
| `signals` | see below | Thresholds for stream signals |
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

## Coordination: the shared board

Every agent reads one shared board before it decides. The board shows what the other agents hold, which coins any agent just sold, and every live signal about a coin. The `claude` brain sees all of this in its prompt. The `traits` brain sells out of flagged coins, skips blocked ones and leans toward coins with buy pressure.

| `coordination` key | Default | |
|---|---|---|
| `maxAgentsPerCoin` | none | At most this many agents hold one coin at once |
| `maxSwarmSolPerCoin` | none | At most this much SOL (at cost) across the swarm in one coin |
| `noSelfTradeMs` | `30000` | After any agent sells a coin, no agent buys it for this long, so the swarm never buys from itself |
| `exitOn` | `["whale_sell", "holder_moved"]` | High-severity signals that sell every agent out of the coin at once, between ticks |
| `avoidOn` | `["whale_sell", "holder_moved", "sell_pressure"]` | Signals that block new buys while they are active |
| `followBuyPressure` | `false` | Let a `buy_pressure` signal wake agents targeting the coin between ticks |

Coordination is about risk: spreading out, getting out together and not trading against each other. There is deliberately nothing for staging buys across wallets to look like organic demand, or for trading between the swarm's own wallets.

## Real-time on-chain data (SVS)

With a `stream` section, the swarm subscribes to Solana Vibe Station's Yellowstone gRPC. It receives every transaction that touches the target tokens as it lands, at `processed` commitment by default.

```json
"stream": {
  "endpoint": "https://basic.grpc.solanavibestation.com",
  "tokenEnv": "SVS_X_TOKEN",
  "accounts": [],
  "commitment": "processed",
  "snapshot": true,
  "deshred": true,
  "deshredHolders": 50
}
```

- **Auth:** set your SVS gRPC key in `SVS_X_TOKEN`. It is sent as the `x-token` header. Use `ultra` or `elite` for those plans, or `<tier>.grpc.atl1` / `<tier>.grpc.ams1` for a fixed region.
- **`accounts`:** extra addresses to stream, such as a pool or bonding curve. The target mints are always included.
- **Holder snapshot:** with `snapshot` on and `SOLANA_RPC_URL` set (your SVS RPC URL works), startup loads each token's supply and its 20 largest holders. The stream keeps them current after that.
- **Parsing:** each transaction is read from its balance changes. That turns it into per-wallet buys, sells and wallet-to-wallet moves, with SOL size and price, on any DEX, bonding curve or aggregator. Pools and curves are spotted and left out of the holder list. Trade prices also feed the agents' price history between ticks.
- **Holder book:** for every wallet, the swarm tracks balance, cost basis, buys and sells, and where its tokens came from.

Signals posted to the board:

| Signal | Fires when | Severity |
|---|---|---|
| `whale_sell` | One sell of at least `whaleSellPct`% of supply | high: swarm exits now |
| `holder_moved` | A holder with at least `holderMovedPct`% of supply moves tokens to another wallet (a common step before a dump) | high: swarm exits now |
| `sell_pressure` | Likely-seller overhang reaches `overhangPct`% of supply. Overhang is the sum over the top 50 holders of share × sell risk. | low, or high at twice the threshold |
| `buy_pressure` | At least `buyPressureBuyers` distinct wallets put in `buyPressureSol` SOL net within `windowSec` | low |
| `pending_sell` | Deshred: a holder's sell is in a block but not yet executed. It must be at least `whaleSellPct`% of supply, or come from a holder that big. | high if the sell itself is that big, low otherwise |
| `pending_move` | Deshred: a holder with at least `holderMovedPct`% is moving tokens to another wallet, not yet executed | high: swarm exits now |
| `pending_activity` | Deshred: a holder that size sent a transaction through some other program that touches its bag (direction unknown) | low: blocks buys |

A holder's sell risk is a 0 to 1 heuristic. It rises when the holder:

- is up on its entry, at full weight from `signals.risk.profitFullAt`, 3x by default
- sold recently and still holds
- just received tokens moved from another holder
- has been splitting its bag across wallets
- is a quick flip in profit

The swarm's own wallets never trigger signals.

```sh
SVS_X_TOKEN=... SOLANA_RPC_URL=... pnpm start -- --config swarm.json --watch   # flows and signals only, no trading
```

`--watch` prints every parsed flow and signal as JSON lines. Use it to check your token and tune thresholds before letting agents act on them. During a normal run, set `SWARM_LOG_FLOWS=1` to log flows too.

### Seeing sells before they execute (deshred)

With `deshred` on (the default), a second gRPC connection subscribes to `SubscribeDeshred`. SVS offers it on every gRPC plan. It delivers transactions as soon as their shreds are reassembled, before the validator runs them. Triton measures about 6 ms at p50 from shred arrival. Normal streams deliver only after execution.

- **No balances yet:** a pending transaction has no balance changes, so the swarm decodes the instructions themselves. Pump.fun, PumpSwap, Raydium AMM v4 and Raydium CPMM swaps are decoded with direction and amount. Plain SPL transfers and TransferChecked are decoded too, including the new wallet's token account when it is created in the same transaction. Any other program that touches a holder's known token account is reported as `pending_activity`.
- **Filter:** covers the target mints plus the top `deshredHolders` holders' wallets and token accounts per token, refreshed every minute. That catches transfers and v4 swaps that never name the mint.
- **How early:** when the executed version of a transaction arrives, `--watch` prints `seenEarlyMs` on its flow, so you can see how early deshred saw it.

**What it means:** when a whale's sell shows up in deshred, it is already placed in a block, so the swarm's sell lands after it, never before. The gain is reacting in the same or next slot, ahead of everyone waiting on executed or confirmed data. Bots on the same shred feed are just as fast. A pending transaction can also still fail or land on a fork, so a false alarm costs one exit.

**Still not covered:** transactions waiting to get into a block. Solana has none to watch publicly. Before deshred, the earliest warnings are the holder signals above: profit, wallet moves and partial sells.

**Decoder layouts are untested against live traffic.** Run `--watch` on a live token and compare the `pending` lines with the executed `flow` lines before you trust the exits.

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
- Holder books start from the RPC snapshot (top 20) and only learn cost basis from trades seen live, so profit-based risk builds up while the stream runs.
- The swarm keeps its books in memory, so a restart starts every agent fresh (positions in a live wallet stay put; sell them by hand or with a new run's agents).
- Trading AgentChain coins live still goes through the engine's own runtime (`ENGINE_ROLE=runtime`); here the `agentchain` feed is for paper runs, and graduated coins can be traded live through Jupiter.
