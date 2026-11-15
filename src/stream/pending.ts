// Pre-execution intent decoding for deshred transactions.
//
// A deshred transaction arrives before the validator runs it, so there are no
// balance changes to read: we decode the instructions instead. Known venues are
// decoded exactly (amount and direction); anything else that touches a holder's
// token account is reported as activity with an unknown direction.
//
// A pending transaction may still fail, land on a fork or never land. Treat it
// as a warning, and confirm with the executed stream (same signature).
import { createHash } from "node:crypto";

import { getBase58Decoder } from "@solana/kit";

import type { TxLike } from "./parse";

export const PROGRAMS = {
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  pump: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  raydiumV4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  raydiumCpmm: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
} as const;

/** Programs that never move a holder's tokens by themselves. */
const IGNORED = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  PROGRAMS.ata,
]);

/** Anchor instruction discriminator: first 8 bytes of sha256("global:<name>"). */
export const anchorDisc = (name: string) => new Uint8Array(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
const DISC = {
  swapBaseInput: anchorDisc("swap_base_input"),
  swapBaseOutput: anchorDisc("swap_base_output"),
};

/**
 * Buy/sell instructions, from the official IDLs (github.com/pump-fun/pump-public-docs/idl).
 * mint/user: account indexes. amountAt: byte offset of the token amount; "bound" means it is a
 * minimum (exact-SOL-in buys), not the exact amount.
 */
interface SwapIx { side: "buy" | "sell"; mint: number; user: number; amountAt: number; bound?: boolean; quoteAt: number }
const entry = (name: string, l: SwapIx) => [Buffer.from(anchorDisc(name)).toString("hex"), l] as const;
const PUMP_IX = new Map<string, SwapIx>([
  entry("buy", { side: "buy", mint: 2, user: 6, amountAt: 8, quoteAt: 16 }),
  entry("buy_exact_sol_in", { side: "buy", mint: 2, user: 6, amountAt: 16, bound: true, quoteAt: 8 }),
  entry("sell", { side: "sell", mint: 2, user: 6, amountAt: 8, quoteAt: 16 }),
  entry("buy_v2", { side: "buy", mint: 1, user: 13, amountAt: 8, quoteAt: 16 }),
  entry("buy_exact_quote_in_v2", { side: "buy", mint: 1, user: 13, amountAt: 16, bound: true, quoteAt: 8 }),
  entry("sell_v2", { side: "sell", mint: 1, user: 13, amountAt: 8, quoteAt: 16 }),
  entry("buy_v3", { side: "buy", mint: 1, user: 8, amountAt: 8, quoteAt: 16 }),
  entry("buy_exact_quote_in_v3", { side: "buy", mint: 1, user: 8, amountAt: 16, bound: true, quoteAt: 8 }),
  entry("sell_v3", { side: "sell", mint: 1, user: 8, amountAt: 8, quoteAt: 16 }),
]);
// PumpSwap: every variant starts pool, user, global_config, base_mint, quote_mint.
const PUMPSWAP_IX = new Map<string, SwapIx>([
  entry("buy", { side: "buy", mint: 3, user: 1, amountAt: 8, quoteAt: 16 }),
  entry("buy_v2", { side: "buy", mint: 3, user: 1, amountAt: 8, quoteAt: 16 }),
  entry("buy_exact_quote_in", { side: "buy", mint: 3, user: 1, amountAt: 16, bound: true, quoteAt: 8 }),
  entry("buy_exact_quote_in_v2", { side: "buy", mint: 3, user: 1, amountAt: 16, bound: true, quoteAt: 8 }),
  entry("sell", { side: "sell", mint: 3, user: 1, amountAt: 8, quoteAt: 16 }),
  entry("sell_v2", { side: "sell", mint: 3, user: 1, amountAt: 8, quoteAt: 16 }),
]);
const disc8 = (d: Uint8Array) => (d.length >= 8 ? Buffer.from(d.subarray(0, 8)).toString("hex") : "");
const startsWith = (data: Uint8Array, d: Uint8Array) => data.length >= d.length && d.every((b, i) => data[i] === b);
const u64 = (data: Uint8Array, off: number): bigint => (data.length >= off + 8 ? new DataView(data.buffer, data.byteOffset + off, 8).getBigUint64(0, true) : 0n);

export interface TokenAccountInfo {
  owner: string;
  mint: string;
}

/** Token account address -> owner and mint, learned from snapshots, executed txs and ATA creations. */
export class TokenAccountIndex {
  readonly map = new Map<string, TokenAccountInfo>();
  set(account: string, info: TokenAccountInfo) {
    this.map.set(account, info);
  }
  get(account: string) {
    return this.map.get(account);
  }
  /** Token accounts of this mint owned by these wallets. */
  accountsOf(mint: string, owners: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const [acc, i] of this.map) if (i.mint === mint && owners.has(i.owner)) out.push(acc);
    return out;
  }
}

/** Records the token accounts of target mints seen in an executed transaction. */
export function learnTokenAccounts(tx: TxLike, targets: ReadonlySet<string>, index: TokenAccountIndex) {
  for (const b of [...tx.preTokenBalances, ...tx.postTokenBalances]) {
    const acc = tx.accountKeys[b.accountIndex];
    if (acc && targets.has(b.mint)) index.set(acc, { owner: b.owner, mint: b.mint });
  }
}

export interface PendingIx {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

export interface PendingTx {
  signature: string;
  slot: number;
  ts: number;
  accountKeys: string[];
  signers: string[];
  instructions: PendingIx[];
}

export type IntentKind = "sell" | "buy" | "move" | "activity";

export interface PendingIntent {
  signature: string;
  slot: number;
  ts: number;
  mint: string;
  /** The wallet whose tokens are about to move. */
  owner: string;
  kind: IntentKind;
  /** Raw token amount when the instruction states it (sell/move exact; buys may be a bound). */
  amountRaw?: bigint;
  venue: string;
  /** For moves: the receiving wallet (or token account, if its owner is unknown). */
  to?: string;
}

export function decodePending(tx: PendingTx, targets: ReadonlySet<string>, index: TokenAccountIndex): PendingIntent[] {
  const out: PendingIntent[] = [];
  const base = { signature: tx.signature, slot: tx.slot, ts: tx.ts };
  const ownerOf = (acc: string) => index.get(acc)?.owner;

  // ATA creations in this transaction tell us who owns a brand-new token account.
  for (const ix of tx.instructions) {
    if (ix.programId === PROGRAMS.ata && ix.accounts.length >= 4 && targets.has(ix.accounts[3]!)) index.set(ix.accounts[1]!, { owner: ix.accounts[2]!, mint: ix.accounts[3]! });
  }

  for (const ix of tx.instructions) {
    const a = ix.accounts;
    const d = ix.data;
    if (ix.programId === PROGRAMS.token || ix.programId === PROGRAMS.token2022) {
      // Transfer: [3, amount u64]  accounts [source, dest, authority]
      // TransferChecked: [12, amount u64, decimals u8]  accounts [source, mint, dest, authority]
      const checked = d[0] === 12;
      if ((d[0] === 3 && a.length >= 3) || (checked && a.length >= 4)) {
        const src = a[0]!;
        const dest = checked ? a[2]! : a[1]!;
        const mint = checked ? a[1]! : index.get(src)?.mint;
        if (!mint || !targets.has(mint)) continue;
        const owner = ownerOf(src) ?? (checked ? a[3]! : a[2]!);
        out.push({ ...base, mint, owner, kind: "move", amountRaw: u64(d, 1), venue: "spl-transfer", to: ownerOf(dest) ?? dest });
      }
      continue;
    }
    if (ix.programId === PROGRAMS.pump) {
      const l = PUMP_IX.get(disc8(d));
      const mint = l && a[l.mint];
      if (!l || !mint || !targets.has(mint) || !a[l.user]) continue;
      out.push({ ...base, mint, owner: a[l.user]!, kind: l.side, amountRaw: u64(d, l.amountAt), venue: "pump.fun" });
      continue;
    }
    if (ix.programId === PROGRAMS.pumpSwap) {
      const l = PUMPSWAP_IX.get(disc8(d));
      if (!l || a.length < 5) continue;
      const [, user, , baseMint, quoteMint] = a as [string, string, string, string, string];
      if (targets.has(baseMint)) out.push({ ...base, mint: baseMint, owner: user, kind: l.side, amountRaw: u64(d, l.amountAt), venue: "pumpswap" });
      // Target is the quote side: buying base spends it, selling base receives it.
      else if (targets.has(quoteMint)) out.push({ ...base, mint: quoteMint, owner: user, kind: l.side === "buy" ? "sell" : "buy", amountRaw: u64(d, l.quoteAt), venue: "pumpswap" });
      continue;
    }
    if (ix.programId === PROGRAMS.raydiumV4 && (d[0] === 9 || d[0] === 11) && a.length >= 17) {
      // swapBaseIn [9, amount_in, min_out] / swapBaseOut [11, max_in, amount_out]; last three accounts: user source, user destination, user owner.
      const src = a[a.length - 3]!;
      const dst = a[a.length - 2]!;
      const owner = a[a.length - 1]!;
      const s = index.get(src);
      const t = index.get(dst);
      if (s && targets.has(s.mint)) out.push({ ...base, mint: s.mint, owner, kind: "sell", amountRaw: u64(d, 1), venue: "raydium-v4" });
      else if (t && targets.has(t.mint)) out.push({ ...base, mint: t.mint, owner, kind: "buy", amountRaw: d[0] === 11 ? u64(d, 9) : undefined, venue: "raydium-v4" });
      continue;
    }
    if (ix.programId === PROGRAMS.raydiumCpmm && a.length >= 12 && (startsWith(d, DISC.swapBaseInput) || startsWith(d, DISC.swapBaseOutput))) {
      // accounts: payer, authority, amm_config, pool, input_ta, output_ta, input_vault, output_vault, in_prog, out_prog, input_mint, output_mint, ...
      const exactIn = startsWith(d, DISC.swapBaseInput);
      const inMint = a[10]!;
      const outMint = a[11]!;
      if (targets.has(inMint)) out.push({ ...base, mint: inMint, owner: a[0]!, kind: "sell", amountRaw: u64(d, 8), venue: "raydium-cpmm" });
      else if (targets.has(outMint)) out.push({ ...base, mint: outMint, owner: a[0]!, kind: "buy", amountRaw: exactIn ? undefined : u64(d, 16), venue: "raydium-cpmm" });
      continue;
    }
  }

  // Anything else (aggregators, other DEXes) that touches the signer's known target token account.
  const decoded = new Set(out.map((i) => `${i.owner}|${i.mint}`));
  const otherProgram = tx.instructions.some((ix) => !IGNORED.has(ix.programId) && !Object.values(PROGRAMS).includes(ix.programId as never));
  if (otherProgram) {
    for (const key of tx.accountKeys) {
      const info = index.get(key);
      if (!info || !targets.has(info.mint) || !tx.signers.includes(info.owner)) continue;
      const k = `${info.owner}|${info.mint}`;
      if (decoded.has(k)) continue;
      decoded.add(k);
      out.push({ ...base, mint: info.mint, owner: info.owner, kind: "activity", venue: "other" });
    }
  }
  return out;
}

// ---- Yellowstone deshred adapter ----------------------------------------------------

const b58 = getBase58Decoder();
const enc = (u: Uint8Array) => b58.decode(u);

/** Minimal shape of SubscribeUpdateDeshred.deshredTransaction. */
export interface GeyserDeshredUpdate {
  slot: string;
  transaction?: {
    signature: Uint8Array;
    isVote: boolean;
    transaction?: { message?: { header?: { numRequiredSignatures: number }; accountKeys: Uint8Array[]; instructions: { programIdIndex: number; accounts: Uint8Array; data: Uint8Array }[] } };
    loadedWritableAddresses: Uint8Array[];
    loadedReadonlyAddresses: Uint8Array[];
  };
}

export function fromDeshred(u: GeyserDeshredUpdate, ts = Date.now()): PendingTx | null {
  const info = u.transaction;
  const msg = info?.transaction?.message;
  if (!info || !msg || info.isVote) return null;
  const keys = [...msg.accountKeys, ...info.loadedWritableAddresses, ...info.loadedReadonlyAddresses].map(enc);
  const nSigners = msg.header?.numRequiredSignatures ?? 1;
  return {
    signature: enc(info.signature),
    slot: Number(u.slot),
    ts,
    accountKeys: keys,
    signers: keys.slice(0, nSigners),
    instructions: msg.instructions.map((ix) => ({ programId: keys[ix.programIdIndex] ?? "", accounts: [...ix.accounts].map((i) => keys[i] ?? ""), data: ix.data })),
  };
}
