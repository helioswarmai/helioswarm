// Turns a landed transaction into token flows: who bought, sold or moved a
// target token, how much, and at what SOL price. It reads only balance changes
// (pre/post token balances and lamports), so it works the same for every DEX,
// bonding curve and aggregator route without decoding any program.
import { getBase58Decoder } from "@solana/kit";

import { SOL_MINT } from "../feeds";

export interface TokenBal {
  accountIndex: number;
  mint: string;
  owner: string;
  /** Raw amount (smallest units). */
  amount: bigint;
  decimals: number;
}

/** The parts of a transaction the parser needs, independent of the wire format. */
export interface TxLike {
  signature: string;
  slot: number;
  ts: number;
  failed: boolean;
  /** Static keys, then loaded writable, then loaded readonly (the runtime's order). */
  accountKeys: string[];
  /** How many leading account keys signed. */
  signers: number;
  fee: bigint;
  preBalances: bigint[];
  postBalances: bigint[];
  preTokenBalances: TokenBal[];
  postTokenBalances: TokenBal[];
}

export type FlowKind = "buy" | "sell" | "transfer_in" | "transfer_out";

export interface TokenFlow {
  signature: string;
  slot: number;
  ts: number;
  mint: string;
  /** The wallet (token account owner) whose balance changed. */
  owner: string;
  kind: FlowKind;
  /** Signed change in raw units. */
  deltaRaw: bigint;
  decimals: number;
  /** Whole tokens moved (always positive). */
  tokens: number;
  /** SOL paid (buy) or received (sell), fee excluded. 0 for transfers. */
  sol: number;
  /** SOL per whole token, for buys and sells. */
  priceSol?: number;
  /** For transfers: the other side, when the same transaction shows it. */
  counterparty?: string;
}

export interface ParsedTx {
  flows: TokenFlow[];
  /** Non-signers that swapped token for SOL in the same transaction: pools and bonding curves. */
  pools: string[];
}

type Key = string; // `${owner}|${mint}`

function tokenDeltas(tx: TxLike): Map<Key, { owner: string; mint: string; delta: bigint; decimals: number }> {
  const out = new Map<Key, { owner: string; mint: string; delta: bigint; decimals: number }>();
  const add = (b: TokenBal, sign: 1n | -1n) => {
    const k = `${b.owner}|${b.mint}`;
    const cur = out.get(k) ?? { owner: b.owner, mint: b.mint, delta: 0n, decimals: b.decimals };
    cur.delta += sign * b.amount;
    out.set(k, cur);
  };
  for (const b of tx.preTokenBalances) add(b, -1n);
  for (const b of tx.postTokenBalances) add(b, 1n);
  return out;
}

export function parseTx(tx: TxLike, targets: ReadonlySet<string>): ParsedTx {
  if (tx.failed) return { flows: [], pools: [] };
  const tok = tokenDeltas(tx);
  const signerSet = new Set(tx.accountKeys.slice(0, tx.signers));
  const feePayer = tx.accountKeys[0];
  const native = (owner: string): bigint => {
    let d = 0n;
    tx.accountKeys.forEach((k, i) => {
      if (k === owner) d += (tx.postBalances[i] ?? 0n) - (tx.preBalances[i] ?? 0n);
    });
    if (owner === feePayer) d += tx.fee; // the network fee isn't part of the trade
    return d;
  };
  const wsol = (owner: string): bigint => tok.get(`${owner}|${SOL_MINT}`)?.delta ?? 0n;

  const flows: TokenFlow[] = [];
  const pools: string[] = [];
  const transfersOut: TokenFlow[] = [];
  const transfersIn: TokenFlow[] = [];

  for (const { owner, mint, delta, decimals } of tok.values()) {
    if (!targets.has(mint) || delta === 0n) continue;
    const solLeg = native(owner) + wsol(owner); // lamports, signed
    const opposite = (delta > 0n && solLeg < 0n) || (delta < 0n && solLeg > 0n);
    const tokens = Number(delta < 0n ? -delta : delta) / 10 ** decimals;
    const base = { signature: tx.signature, slot: tx.slot, ts: tx.ts, mint, owner, deltaRaw: delta, decimals, tokens };
    if (!signerSet.has(owner)) {
      // A non-signer whose token and SOL moved in opposite directions is the other side of a swap.
      if (opposite) {
        pools.push(owner);
        continue;
      }
      const f: TokenFlow = { ...base, kind: delta > 0n ? "transfer_in" : "transfer_out", sol: 0 };
      (delta > 0n ? transfersIn : transfersOut).push(f);
      flows.push(f);
      continue;
    }
    if (opposite) {
      const sol = Number(solLeg < 0n ? -solLeg : solLeg) / 1e9;
      flows.push({ ...base, kind: delta > 0n ? "buy" : "sell", sol, priceSol: tokens > 0 ? sol / tokens : undefined });
    } else {
      const f: TokenFlow = { ...base, kind: delta > 0n ? "transfer_in" : "transfer_out", sol: 0 };
      (delta > 0n ? transfersIn : transfersOut).push(f);
      flows.push(f);
    }
  }
  // Pair simple one-to-one transfers so the holder book knows where tokens went.
  for (const out of transfersOut) {
    const match = transfersIn.filter((i) => i.mint === out.mint);
    if (match.length === 1) {
      out.counterparty = match[0]!.owner;
      match[0]!.counterparty = out.owner;
    }
  }
  return { flows, pools };
}

// ---- Yellowstone (geyser.proto) adapter -------------------------------------------

const b58 = getBase58Decoder();
const enc = (u: Uint8Array) => b58.decode(u);

interface GeyserTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount?: { amount: string; decimals: number };
}

/** Minimal shape of SubscribeUpdate.transaction from @triton-one/yellowstone-grpc. */
export interface GeyserTxUpdate {
  slot: string;
  transaction?: {
    signature: Uint8Array;
    transaction?: { message?: { header?: { numRequiredSignatures: number }; accountKeys: Uint8Array[] } };
    meta?: {
      err?: unknown;
      fee: string;
      preBalances: string[];
      postBalances: string[];
      preTokenBalances: GeyserTokenBalance[];
      postTokenBalances: GeyserTokenBalance[];
      loadedWritableAddresses: Uint8Array[];
      loadedReadonlyAddresses: Uint8Array[];
    };
  };
}

const tb = (b: GeyserTokenBalance): TokenBal => ({
  accountIndex: b.accountIndex,
  mint: b.mint,
  owner: b.owner,
  amount: BigInt(b.uiTokenAmount?.amount ?? "0"),
  decimals: b.uiTokenAmount?.decimals ?? 0,
});

export function fromGeyser(u: GeyserTxUpdate, ts = Date.now()): TxLike | null {
  const info = u.transaction;
  const msg = info?.transaction?.message;
  const meta = info?.meta;
  if (!info || !msg || !meta) return null;
  return {
    signature: enc(info.signature),
    slot: Number(u.slot),
    ts,
    failed: meta.err != null,
    accountKeys: [...msg.accountKeys, ...meta.loadedWritableAddresses, ...meta.loadedReadonlyAddresses].map(enc),
    signers: msg.header?.numRequiredSignatures ?? 1,
    fee: BigInt(meta.fee),
    preBalances: meta.preBalances.map(BigInt),
    postBalances: meta.postBalances.map(BigInt),
    preTokenBalances: meta.preTokenBalances.map(tb),
    postTokenBalances: meta.postTokenBalances.map(tb),
  };
}
