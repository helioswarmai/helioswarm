import { getBase58Encoder } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { anchorDisc, decodePending, fromDeshred, parseConfig, PROGRAMS, SignalEngine, TokenAccountIndex, type PendingIx, type PendingTx, type Signal } from "../src";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WSOL = "So11111111111111111111111111111111111111112";
const WHALE = "7peAHZF9XoXmMD6apts9it4Z7nLuS2qLK1inbz8553Y";
const FRESH = "FVpPRFP4nGm3u9JH5e1yVFHpeN1ZQj5twxzDurBjmyGT";
const WHALE_TA = "3RUsLBV7cnGsJAJVVE1P5p7mNcfuMx1dgoTgAU9tPpUK";
const FRESH_TA = "3EmsAjo5YtFAB1ha6R9og3TNycj8h3jdYzR3aJCEGZSi";
const X = "G5KCzWiMRr5rxXAJPReSLomqrLmPG2YNTXmciY3rXpsJ"; // filler account
const targets = new Set([MINT]);

const le = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const data = (...parts: (Uint8Array | number[])[]) => new Uint8Array(parts.flatMap((p) => [...p]));
const tx = (instructions: PendingIx[], signers = [WHALE]): PendingTx => ({
  signature: "sig1",
  slot: 9,
  ts: 1_000,
  signers,
  accountKeys: [...signers, ...new Set(instructions.flatMap((i) => [i.programId, ...i.accounts]))],
  instructions,
});
const index = () => {
  const i = new TokenAccountIndex();
  i.set(WHALE_TA, { owner: WHALE, mint: MINT });
  return i;
};

describe("decodePending", () => {
  it("decodes a pump.fun sell with its token amount", () => {
    const ix = { programId: PROGRAMS.pump, accounts: [X, X, MINT, X, X, WHALE_TA, WHALE], data: data(anchorDisc("sell"), le(5_000n), le(1n)) };
    expect(decodePending(tx([ix]), targets, index())).toEqual([{ signature: "sig1", slot: 9, ts: 1_000, mint: MINT, owner: WHALE, kind: "sell", amountRaw: 5_000n, venue: "pump.fun" }]);
  });

  it("decodes PumpSwap sells on either side of the pool", () => {
    const sellBase = { programId: PROGRAMS.pumpSwap, accounts: [X, WHALE, X, MINT, WSOL], data: data(anchorDisc("sell"), le(700n), le(1n)) };
    expect(decodePending(tx([sellBase]), targets, index())[0]).toMatchObject({ kind: "sell", amountRaw: 700n, venue: "pumpswap" });
    // Target is the quote: "buy" base (WSOL) means paying up to max_quote_in of the target, i.e. selling it.
    const buyBase = { programId: PROGRAMS.pumpSwap, accounts: [X, WHALE, X, WSOL, MINT], data: data(anchorDisc("buy"), le(1n), le(900n)) };
    expect(decodePending(tx([buyBase]), targets, index())[0]).toMatchObject({ kind: "sell", amountRaw: 900n });
  });

  it("decodes a Raydium v4 sell from the source token account", () => {
    const accounts = [...Array(14).fill(X), WHALE_TA, X, WHALE];
    const ix = { programId: PROGRAMS.raydiumV4, accounts, data: data([9], le(1_234n), le(1n)) };
    expect(decodePending(tx([ix]), targets, index())[0]).toMatchObject({ kind: "sell", amountRaw: 1_234n, venue: "raydium-v4", owner: WHALE });
  });

  it("decodes a Raydium CPMM swap selling the target", () => {
    const accounts = [WHALE, X, X, X, WHALE_TA, X, X, X, X, X, MINT, WSOL, X];
    const ix = { programId: PROGRAMS.raydiumCpmm, accounts, data: data(anchorDisc("swap_base_input"), le(42n), le(1n)) };
    expect(decodePending(tx([ix]), targets, index())[0]).toMatchObject({ kind: "sell", amountRaw: 42n, venue: "raydium-cpmm" });
  });

  it("decodes a move to a brand-new wallet, learning its token account from the ATA creation", () => {
    const create = { programId: PROGRAMS.ata, accounts: [WHALE, FRESH_TA, FRESH, MINT, X, X], data: data([1]) };
    const transfer = { programId: PROGRAMS.token, accounts: [WHALE_TA, FRESH_TA, WHALE], data: data([3], le(10_000n)) };
    const out = decodePending(tx([create, transfer]), targets, index());
    expect(out).toEqual([{ signature: "sig1", slot: 9, ts: 1_000, mint: MINT, owner: WHALE, kind: "move", amountRaw: 10_000n, venue: "spl-transfer", to: FRESH }]);
    const checked = { programId: PROGRAMS.token2022, accounts: [WHALE_TA, MINT, X, WHALE], data: data([12], le(5n), [6]) };
    expect(decodePending(tx([checked]), targets, index())[0]).toMatchObject({ kind: "move", amountRaw: 5n, to: X });
  });

  it("flags unknown programs touching a holder's bag as activity, and ignores other mints", () => {
    const ix = { programId: X, accounts: [WHALE_TA, WHALE], data: data([7]) };
    expect(decodePending(tx([ix]), targets, index())[0]).toMatchObject({ kind: "activity", venue: "other", owner: WHALE });
    const otherMint = { programId: PROGRAMS.pump, accounts: [X, X, WSOL, X, X, X, WHALE], data: data(anchorDisc("sell"), le(1n), le(1n)) };
    expect(decodePending(tx([otherMint]), targets, index())).toEqual([]);
  });

  it("adapts a Yellowstone deshred update", () => {
    const b = getBase58Encoder();
    const raw = (s: string) => new Uint8Array(b.encode(s));
    const p = fromDeshred({
      slot: "77",
      transaction: {
        signature: raw("5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7"),
        isVote: false,
        transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [raw(WHALE), raw(PROGRAMS.token)], instructions: [{ programIdIndex: 1, accounts: new Uint8Array([2, 0]), data: new Uint8Array([3]) }] } },
        loadedWritableAddresses: [raw(WHALE_TA)],
        loadedReadonlyAddresses: [],
      },
    })!;
    expect(p.slot).toBe(77);
    expect(p.signers).toEqual([WHALE]);
    expect(p.instructions[0]).toMatchObject({ programId: PROGRAMS.token, accounts: [WHALE_TA, WHALE] });
  });
});

describe("pending signals", () => {
  const setup = (ours: string[] = []) => {
    const out: Signal[] = [];
    const cfg = parseConfig({ groups: [{ preset: "degen", bankrollSol: 1, targets: [MINT] }] }).signals;
    const eng = new SignalEngine([MINT], (s) => out.push(s), cfg, new Set(ours));
    const book = eng.books.get(MINT)!;
    book.supplyRaw = 1_000_000n;
    book.seed(WHALE, 50_000n, 0); // 5%
    return { out, eng };
  };
  const sell = (amountRaw: bigint) => ({ signature: "s", slot: 1, ts: 1_000, mint: MINT, owner: WHALE, kind: "sell" as const, amountRaw, venue: "pump.fun" });

  it("fires a high pending_sell for a big sell before it executes, and measures how early", () => {
    const { out, eng } = setup();
    eng.ingestPending([sell(20_000n)]); // 2% of supply
    expect(out[0]).toMatchObject({ kind: "pending_sell", severity: "high", signature: "s" });
    expect(out[0]!.reasons[0]).toMatch(/not yet executed/);
    expect(eng.seenEarly("s", 1_350)).toBe(350);
    expect(eng.seenEarly("s", 1_400)).toBeUndefined();
  });

  it("a small sell from a big holder is a low warning; our own wallets never fire", () => {
    const { out, eng } = setup();
    eng.ingestPending([sell(10n)]);
    expect(out[0]).toMatchObject({ kind: "pending_sell", severity: "low" });
    const o2 = setup([WHALE]);
    o2.eng.ingestPending([sell(20_000n)]);
    expect(o2.out).toEqual([]);
  });

  it("fires pending_move for a big holder moving tokens, and exits by default", () => {
    const { out, eng } = setup();
    eng.ingestPending([{ signature: "m", slot: 1, ts: 1, mint: MINT, owner: WHALE, kind: "move", amountRaw: 50_000n, venue: "spl-transfer", to: FRESH }]);
    expect(out[0]).toMatchObject({ kind: "pending_move", severity: "high" });
    const c = parseConfig({ groups: [{ preset: "degen", bankrollSol: 1, targets: [MINT] }] });
    expect(c.coordination.exitOn).toEqual(expect.arrayContaining(["pending_sell", "pending_move"]));
    expect(c.stream).toBeNull();
    expect(parseConfig({ groups: [{ preset: "degen", bankrollSol: 1, targets: [MINT] }], stream: {} }).stream).toMatchObject({ deshred: true, deshredHolders: 50 });
  });
});
