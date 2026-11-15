// One Solana wallet per agent. Each agent's keypair lives in its own
// solana-keygen JSON file, <walletsDir>/<agent id>.json, so every agent signs
// its own swaps from its own address. Files are created once and never
// overwritten: deleting one loses whatever that wallet still holds.
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { address, createKeyPairSignerFromBytes, createSolanaRpc, type KeyPairSigner } from "@solana/kit";

/** Agent ids can carry characters that don't belong in a filename (e.g. "kev#2"). */
export const walletFileName = (agentId: string) => `${agentId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;

export const walletPath = (dir: string, agentId: string) => join(dir, walletFileName(agentId));

/** A fresh ed25519 keypair in solana-keygen layout: 32-byte seed then 32-byte public key. */
export function newKeypairBytes(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  if (d.length !== 32 || x.length !== 32) throw new Error("unexpected ed25519 key length");
  return new Uint8Array([...d, ...x]);
}

/** Reads a solana-keygen JSON keypair file. */
export async function loadKeypairFile(path: string): Promise<KeyPairSigner> {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${path} is not a 64-byte keypair file`);
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

/** Creates a keypair file for every agent that doesn't have one yet. Returns the ids it created. */
export function ensureWallets(dir: string, agentIds: string[]): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  const files = new Map<string, string>();
  for (const id of agentIds) {
    const file = walletPath(dir, id);
    const other = files.get(file);
    if (other) throw new Error(`agents "${other}" and "${id}" would share wallet file ${file}; rename one`);
    files.set(file, id);
    if (existsSync(file)) continue;
    writeFileSync(file, JSON.stringify([...newKeypairBytes()]), { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    created.push(id);
  }
  return created;
}

/** Loads every agent's signer. Fails listing every agent without a wallet file. */
export async function loadWallets(dir: string, agentIds: string[]): Promise<Map<string, KeyPairSigner>> {
  const missing = agentIds.filter((id) => !existsSync(walletPath(dir, id)));
  if (missing.length) throw new Error(`no wallet file for ${missing.join(", ")} in ${dir} (run with --wallets to create them)`);
  const out = new Map<string, KeyPairSigner>();
  const owners = new Map<string, string>();
  for (const id of agentIds) {
    const signer = await loadKeypairFile(walletPath(dir, id));
    const prev = owners.get(signer.address);
    if (prev) throw new Error(`agents "${prev}" and "${id}" have the same wallet ${signer.address}; every agent needs its own`);
    owners.set(signer.address, id);
    out.set(id, signer);
  }
  return out;
}

/** SOL balance of each wallet, by agent id. */
export async function solBalances(rpcUrl: string, wallets: Map<string, KeyPairSigner>): Promise<Map<string, number>> {
  const rpc = createSolanaRpc(rpcUrl);
  const out = new Map<string, number>();
  for (const [id, w] of wallets) {
    const { value } = await rpc.getBalance(address(w.address)).send();
    out.set(id, Number(value) / 1e9);
  }
  return out;
}
