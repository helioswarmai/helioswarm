import { getBase58Encoder } from "@solana/kit";
import { describe, expect, it } from "vitest";

import {
  Board,
  DEFAULT_COORDINATION,
  expandGroups,
  fromGeyser,
  HolderBook,
  holderRisk,
  Ledger,
  PaperVenue,
  parseConfig,
  parseTx,
  SignalEngine,
  SimFeed,
  SOL_MINT,
  Swarm,
  TraitBrain,
  type Signal,
  type TokenBal,
  type TxLike,
} from "../src";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const USER = "7peAHZF9XoXmMD6apts9it4Z7nLuS2qLK1inbz8553Y";
const POOL = "G5KCzWiMRr5rxXAJPReSLomqrLmPG2YNTXmciY3rXpsJ";
const FRESH = "FVpPRFP4nGm3u9JH5e1yVFHpeN1ZQj5twxzDurBjmyGT";
const targets = new Set([MINT]);
const bal = (accountIndex: number, owner: string, amount: bigint, mint = MINT, decimals = 6): TokenBal => ({ accountIndex, owner, mint, amount, decimals });

/** USER swaps SOL for 1,000 tokens against POOL (a pump-style curve holding native SOL). */
function buyTx(sol = 1, tokens = 1_000n * 10n ** 6n, user = USER, ts = 1_000): TxLike {
  const lamports = BigInt(sol * 1e9);
  return {
    signature: `buy-${user}-${ts}`,
    slot: 1,
    ts,
    failed: false,
    accountKeys: [user, POOL],
    signers: 1,
    fee: 5_000n,
    preBalances: [10n * 10n ** 9n, 100n * 10n ** 9n],
    postBalances: [10n * 10n ** 9n - lamports - 5_000n, 100n * 10n ** 9n + lamports],
    preTokenBalances: [bal(2, POOL, 1_000_000n * 10n ** 6n)],
    postTokenBalances: [bal(2, POOL, 1_000_000n * 10n ** 6n - tokens), bal(3, user, tokens)],
  };
}

function sellTx(sol: number, tokens: bigint, have: bigint, user = USER, ts = 2_000): TxLike {
  const lamports = BigInt(Math.round(sol * 1e9));
  return {
    signature: `sell-${user}-${ts}`,
    slot: 2,
    ts,
    failed: false,
    accountKeys: [user, POOL],
    signers: 1,
    fee: 5_000n,
    preBalances: [1n * 10n ** 9n, 100n * 10n ** 9n],
    postBalances: [1n * 10n ** 9n + lamports - 5_000n, 100n * 10n ** 9n - lamports],
    preTokenBalances: [bal(2, POOL, 500_000n * 10n ** 6n), bal(3, user, have)],
    postTokenBalances: [bal(2, POOL, 500_000n * 10n ** 6n + tokens), bal(3, user, have - tokens)],
  };
}

function moveTx(from: string, to: string, tokens: bigint, have: bigint, ts = 3_000): TxLike {
  return {
    signature: `move-${ts}`,
    slot: 3,
    ts,
    failed: false,
    accountKeys: [from, to],
    signers: 1,
    fee: 5_000n,
    preBalances: [1n * 10n ** 9n, 0n],
    postBalances: [1n * 10n ** 9n - 5_000n - 2_039_280n, 2_039_280n], // sender pays the new account's rent
    preTokenBalances: [bal(2, from, have)],
    postTokenBalances: [bal(2, from, have - tokens), bal(3, to, tokens)],
  };
}

describe("parseTx", () => {
  it("reads a buy from balance changes and spots the pool", () => {
    const { flows, pools } = parseTx(buyTx(1), targets);
    expect(pools).toEqual([POOL]);
    expect(flows).toHaveLength(1);
    const f = flows[0]!;
    expect(f).toMatchObject({ kind: "buy", owner: USER, tokens: 1000 });
    expect(f.sol).toBeCloseTo(1, 9); // network fee excluded
    expect(f.priceSol).toBeCloseTo(0.001, 9);
  });

  it("reads a sell, including SOL paid out as wrapped SOL", () => {
    const tx = sellTx(0, 400n * 10n ** 6n, 1_000n * 10n ** 6n);
    // Pay the proceeds in WSOL instead of native SOL.
    tx.preTokenBalances.push(bal(4, USER, 0n, SOL_MINT, 9), bal(5, POOL, 50n * 10n ** 9n, SOL_MINT, 9));
    tx.postTokenBalances.push(bal(4, USER, 2n * 10n ** 9n, SOL_MINT, 9), bal(5, POOL, 48n * 10n ** 9n, SOL_MINT, 9));
    tx.postBalances = [...tx.preBalances];
    tx.postBalances[0] = tx.preBalances[0]! - 5_000n;
    const f = parseTx(tx, targets).flows[0]!;
    expect(f.kind).toBe("sell");
    expect(f.sol).toBeCloseTo(2, 9);
    expect(f.tokens).toBe(400);
  });

  it("pairs a wallet-to-wallet move and ignores failed transactions", () => {
    const { flows } = parseTx(moveTx(USER, FRESH, 300n * 10n ** 6n, 1_000n * 10n ** 6n), targets);
    expect(flows.map((f) => [f.kind, f.owner, f.counterparty])).toEqual([
      ["transfer_out", USER, FRESH],
      ["transfer_in", FRESH, USER],
    ]);
    expect(parseTx({ ...buyTx(), failed: true }, targets).flows).toEqual([]);
  });

  it("adapts a Yellowstone transaction update", () => {
    const b = getBase58Encoder();
    const raw = (s: string) => new Uint8Array(b.encode(s));
    const tx = fromGeyser({
      slot: "42",
      transaction: {
        signature: raw("5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7"),
        transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [raw(USER)] } },
        meta: { fee: "5000", preBalances: ["10"], postBalances: ["5"], preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: USER, uiTokenAmount: { amount: "7", decimals: 6 } }], loadedWritableAddresses: [raw(POOL)], loadedReadonlyAddresses: [] },
      },
    })!;
    expect(tx.slot).toBe(42);
    expect(tx.accountKeys).toEqual([USER, POOL]);
    expect(tx.postTokenBalances[0]!.amount).toBe(7n);
    expect(tx.failed).toBe(false);
  });
});

describe("holder book and sell risk", () => {
  it("tracks cost basis and flags a holder sitting on profit", () => {
    const book = new HolderBook(MINT);
    book.supplyRaw = 1_000_000_000n * 10n ** 6n;
    for (const f of parseTx(buyTx(1), targets).flows) book.apply(f); // 1000 tokens at 0.001
    book.lastPriceSol = 0.004; // now 4x
    const h = book.holders.get(USER)!;
    expect(h.costSol).toBeCloseTo(1, 9);
    const r = holderRisk(book, h, 2_000);
    expect(r.risk).toBeGreaterThan(0.4);
    expect(r.reasons.join()).toMatch(/up 4\.0x/);
  });

  it("flags a fresh wallet that received a holder's tokens", () => {
    const book = new HolderBook(MINT);
    book.seed(USER, 1_000n * 10n ** 6n, 0);
    for (const f of parseTx(moveTx(USER, FRESH, 1_000n * 10n ** 6n, 1_000n * 10n ** 6n), targets).flows) book.apply(f);
    const r = holderRisk(book, book.holders.get(FRESH)!, 4_000);
    expect(r.reasons.join()).toMatch(/received tokens moved/);
    expect(book.holders.get(USER)!.movedOutRaw).toBe(1_000n * 10n ** 6n);
  });
});

describe("signal engine", () => {
  const supply = 100_000n * 10n ** 6n;
  const setup = (ours: string[] = [], over: Record<string, unknown> = {}) => {
    const out: Signal[] = [];
    const cfg = parseConfig({ groups: [{ preset: "degen", bankrollSol: 1, targets: [MINT] }], signals: over }).signals;
    const eng = new SignalEngine([MINT], (s) => out.push(s), cfg, new Set(ours));
    eng.books.get(MINT)!.supplyRaw = supply;
    return { out, eng };
  };

  it("fires whale_sell on a large sell and holder_moved when a big holder moves tokens", () => {
    const { out, eng } = setup();
    eng.books.get(MINT)!.seed(USER, 5_000n * 10n ** 6n, 0); // 5% of supply
    eng.ingest(parseTx(sellTx(3, 2_000n * 10n ** 6n, 5_000n * 10n ** 6n), targets)); // sells 2%
    expect(out.map((s) => s.kind)).toContain("whale_sell");
    eng.ingest(parseTx(moveTx(USER, FRESH, 1_500n * 10n ** 6n, 3_000n * 10n ** 6n), targets));
    const moved = out.find((s) => s.kind === "holder_moved")!;
    expect(moved.severity).toBe("high");
    expect(moved.reasons[0]).toMatch(/moved/);
  });

  it("never fires on our own agents' wallets", () => {
    const { out, eng } = setup([USER]);
    eng.books.get(MINT)!.seed(USER, 5_000n * 10n ** 6n, 0);
    eng.ingest(parseTx(sellTx(3, 2_000n * 10n ** 6n, 5_000n * 10n ** 6n), targets));
    expect(out.filter((s) => s.kind === "whale_sell")).toEqual([]);
  });

  it("fires buy_pressure when many wallets buy with size", () => {
    const { out, eng } = setup([], { buyPressureBuyers: 3, buyPressureSol: 2 });
    const wallets = [USER, FRESH, "3RUsLBV7cnGsJAJVVE1P5p7mNcfuMx1dgoTgAU9tPpUK"];
    wallets.forEach((w, i) => eng.ingest(parseTx(buyTx(1, 10n * 10n ** 6n, w, 1_000 + i), targets)));
    expect(out.map((s) => s.kind)).toContain("buy_pressure");
  });
});

describe("board coordination", () => {
  const cfg = (coordination: Record<string, unknown> = {}) => parseConfig({ groups: [{ preset: "degen", count: 3, bankrollSol: 1, targets: [MINT] }], coordination });
  const sig = (kind: Signal["kind"], severity: Signal["severity"] = "high", ts = 0): Signal => ({ mint: MINT, kind, severity, score: 1, reasons: [`${kind} test`], from: "stream", ts, ttlMs: 60_000 });

  it("limits agents per coin, blocks buying from our own sellers, and avoids flagged coins", () => {
    const c = cfg({ maxAgentsPerCoin: 1, noSelfTradeMs: 10_000 });
    const ledger = new Ledger();
    const specs = expandGroups(c.groups);
    for (const s of specs) ledger.open(s.id, 1);
    const board = new Board(ledger, specs, c.coordination);
    ledger.applyBuy({ agent: "degen-1", side: "buy", mint: MINT, sol: 0.1, tokens: 1, priceSol: 0.1, ts: 0, sig: "paper", reason: "" });
    expect(board.buyBlock("degen-2", MINT, 0)).toMatch(/already hold/);
    expect(board.buyBlock("degen-1", MINT, 0)).toBeNull(); // adding to its own position is fine
    expect(board.peers("degen-2")).toEqual([{ agent: "degen-1", preset: "degen", mint: MINT, costSol: 0.1 }]);
    board.recordSell("degen-1", MINT, 1_000);
    expect(board.buyBlock("degen-3", MINT, 5_000)).toMatch(/no buying from our own sellers/);
    board.post(sig("sell_pressure", "low", 20_000));
    expect(board.buyBlock("degen-3", MINT, 21_000)).toMatch(/sell_pressure/);
  });

  it("parses coordination defaults and rejects unknown signal kinds", () => {
    expect(cfg().coordination).toEqual(DEFAULT_COORDINATION);
    expect(() => cfg({ exitOn: ["moon"] })).toThrow(/signal kinds/);
    expect(parseConfig({ groups: [{ preset: "degen", bankrollSol: 1, targets: [MINT] }], stream: { tokenEnv: "T" } }).stream).toMatchObject({ endpoint: "https://basic.grpc.solanavibestation.com", commitment: "processed", tokenEnv: "T" });
  });

  it("sells every holding agent out at once on a high exit signal", async () => {
    const c = cfg();
    const feed = new SimFeed(1, () => 0);
    const fills: Record<string, unknown>[] = [];
    const swarm = new Swarm(c, expandGroups(c.groups), { feed, venue: (l) => new PaperVenue(l, 100, 100), now: () => 0, emit: (l) => l.event === "fill" && fills.push(l) });
    await feed.refresh([MINT]);
    for (const id of ["degen-1", "degen-2"]) swarm.ledger.applyBuy({ agent: id, side: "buy", mint: MINT, sol: 0.1, tokens: 100, priceSol: 0.001, ts: 0, sig: "paper", reason: "" });
    swarm.board.post(sig("whale_sell"));
    await swarm.react(sig("note", "low")); // waits for the reaction queued by post()
    expect(fills.filter((f) => f.side === "sell").map((f) => f.agent).sort()).toEqual(["degen-1", "degen-2"]);
    expect(String(fills[0]!.reason)).toMatch(/swarm exit on whale_sell/);
    expect(swarm.ledger.book("degen-1").positions.size).toBe(0);
  });

  it("the trait brain sells into a sell_pressure signal and skips flagged coins", async () => {
    const c = cfg();
    const specs = expandGroups(c.groups);
    const ledger = new Ledger();
    for (const s of specs) ledger.open(s.id, 1);
    const board = new Board(ledger, specs, c.coordination);
    const feed = new SimFeed(2, () => 0);
    for (let i = 0; i < 20; i++) await feed.refresh([MINT]);
    ledger.applyBuy({ agent: "degen-1", side: "buy", mint: MINT, sol: 0.1, tokens: 100, priceSol: 0.001, ts: 0, sig: "paper", reason: "" });
    board.post(sig("sell_pressure", "low"));
    const brain = new TraitBrain("x");
    const a = await brain.decide({ agent: specs[0]!, book: ledger.book("degen-1"), feed, maxBuySol: 0.05, now: 1, board });
    expect(a).toMatchObject({ kind: "sell", mint: MINT, fraction: 0.5 });
    const b = await brain.decide({ agent: specs[1]!, book: ledger.book("degen-2"), feed, maxBuySol: 0.05, now: 1, board });
    expect(b.kind).toBe("hold");
  });
});
