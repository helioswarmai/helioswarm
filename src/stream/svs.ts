// Yellowstone (Dragon's Mouth) gRPC subscription on Solana Vibe Station.
// Streams every landed transaction that touches the target mints (and any
// extra accounts, e.g. pool addresses), with automatic reconnects.
//
// SVS endpoints: https://<basic|ultra|elite>.grpc.solanavibestation.com
// (or .grpc.atl1. / .grpc.ams1. for a fixed region). Auth is the x-token header.
import { EventEmitter } from "node:events";

import Client, { CommitmentLevel, type SubscribeRequest } from "@triton-one/yellowstone-grpc";

import { fromGeyser, type GeyserTxUpdate, type TxLike } from "./parse";
import type { StreamConfig } from "./types";

export type { StreamConfig } from "./types";

export function subscribeRequest(accounts: string[], commitment: StreamConfig["commitment"]): SubscribeRequest {
  return {
    accounts: {},
    slots: {},
    transactions: {
      swarm: { vote: false, failed: false, accountInclude: accounts, accountExclude: [], accountRequired: [] },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    blockFooter: {},
    accountsDataSlice: [],
    commitment: commitment === "confirmed" ? CommitmentLevel.CONFIRMED : CommitmentLevel.PROCESSED,
  };
}

/** Emits "tx" (TxLike), "status" (string) and "error" (Error). */
export class SvsStream extends EventEmitter {
  private stream?: Awaited<ReturnType<Client["subscribeWithReconnect"]>>;
  private pinger?: NodeJS.Timeout;
  private closed = false;

  constructor(private cfg: StreamConfig, private watch: string[], private token = process.env[cfg.tokenEnv]) {
    super();
  }

  async start() {
    if (!this.token) throw new Error(`stream: env var ${this.cfg.tokenEnv} (SVS x-token) is not set`);
    const accounts = [...new Set([...this.watch, ...this.cfg.accounts])];
    const client = new Client(this.cfg.endpoint, this.token, undefined, { backoff: { initialIntervalMs: 500, multiplier: 2, maxRetries: 20 }, policy: "Replay", slotsBehind: 2 });
    await client.connect();
    this.stream = await client.subscribeWithReconnect(subscribeRequest(accounts, this.cfg.commitment));
    let received = false;
    let drops = 0;
    this.stream.on("data", (ev) => {
      if (ev.type === "Disconnected") {
        drops++;
        if (!received && drops === 3) this.emit("error", new Error(`SVS dropped the connection ${drops} times before sending anything: check the x-token in ${this.cfg.tokenEnv} and that your SVS plan includes gRPC on ${this.cfg.endpoint}`));
        else this.emit("status", `disconnected, ${ev.replayFromSlot ? `replaying from slot ${ev.replayFromSlot}` : "resuming at tip"}`);
        return;
      }
      received = true;
      drops = 0;
      const tx = ev.update.transaction;
      if (!tx) return;
      const parsed = fromGeyser(tx as unknown as GeyserTxUpdate, ev.update.createdAt?.getTime() ?? Date.now());
      if (parsed) this.emit("tx", parsed satisfies TxLike);
    });
    this.stream.on("error", (e) => !this.closed && this.emit("error", e as Error));
    this.stream.on("end", () => !this.closed && this.emit("error", new Error("stream ended")));
    // Keep idle connections alive through load balancers. A ping-only request leaves the filters as they are.
    let id = 1;
    this.pinger = setInterval(() => this.stream?.write({ ...subscribeRequest(accounts, this.cfg.commitment), transactions: {}, ping: { id: id++ } } as SubscribeRequest), 30_000);
    this.pinger.unref();
    this.emit("status", `subscribed to ${accounts.length} accounts on ${this.cfg.endpoint} (${this.cfg.commitment})`);
  }

  stop() {
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    this.stream?.destroy();
  }
}

export function deshredRequest(accounts: string[]) {
  return {
    deshredTransactions: { swarm: { vote: false, accountInclude: accounts, accountExclude: [], accountRequired: [] } },
    slots: {},
  };
}

/**
 * SubscribeDeshred: transactions as soon as their shreds are reassembled, before
 * the validator executes them. No balances or status: decode instructions
 * (see pending.ts). Emits "pending" (PendingTx), "status" and "error".
 * The client has no built-in reconnect for this stream, so it reconnects itself.
 */
export class DeshredStream extends EventEmitter {
  private stream?: Awaited<ReturnType<Client["subscribeDeshred"]>>;
  private pinger?: NodeJS.Timeout;
  private closed = false;
  private accounts: string[];
  private attempt = 0;

  constructor(private cfg: StreamConfig, watch: string[], private token = process.env[cfg.tokenEnv]) {
    super();
    this.accounts = [...new Set([...watch, ...cfg.accounts])];
  }

  async start() {
    if (!this.token) throw new Error(`stream: env var ${this.cfg.tokenEnv} (SVS x-token) is not set`);
    void this.connect(); // runs for the stream's lifetime and reconnects on its own
  }

  /** Replaces the account filter on the live stream (e.g. as the top-holder set changes). */
  setAccounts(accounts: string[]) {
    const next = [...new Set([...accounts, ...this.cfg.accounts])];
    if (next.length === this.accounts.length && next.every((a, i) => a === this.accounts[i])) return;
    this.accounts = next;
    this.stream?.write(deshredRequest(this.accounts));
    this.emit("status", `deshred filter now ${this.accounts.length} accounts`);
  }

  private async connect() {
    const { fromDeshred } = await import("./pending");
    let received = false;
    try {
      const client = new Client(this.cfg.endpoint, this.token, undefined);
      await client.connect();
      const stream = await client.subscribeDeshred();
      this.stream = stream;
      // Listen for the end of the stream before anything can fail on it.
      const ended = new Promise<void>((resolve) => {
        stream.on("error", (e: Error) => {
          if (!this.closed) this.emit("status", `deshred dropped: ${e.message}`);
          resolve();
        });
        stream.once("end", () => resolve());
        stream.once("close", () => resolve());
      });
      stream.write(deshredRequest(this.accounts));
      this.emit("status", `deshred subscription sent for ${this.accounts.length} accounts on ${this.cfg.endpoint}`);
      let id = 1;
      stream.on("data", (u: { deshredTransaction?: unknown; ping?: unknown }) => {
        if (u.ping) {
          stream.write({ ...deshredRequest(this.accounts), ping: { id: id++ } });
          return;
        }
        received = true;
        this.attempt = 0;
        if (!u.deshredTransaction) return;
        const tx = fromDeshred(u.deshredTransaction as never);
        if (tx) this.emit("pending", tx);
      });
      if (this.pinger) clearInterval(this.pinger);
      this.pinger = setInterval(() => this.stream?.write({ ...deshredRequest(this.accounts), ping: { id: id++ } }), 30_000);
      this.pinger.unref();
      await ended;
    } catch (e) {
      if (!this.closed) this.emit("status", `deshred connect failed: ${(e as Error).message}`);
    }
    if (this.closed) return;
    this.attempt++;
    if (!received && this.attempt === 3) this.emit("error", new Error(`deshred: SVS dropped the connection ${this.attempt} times before sending anything: check ${this.cfg.tokenEnv} and that the plan includes SubscribeDeshred`));
    const wait = Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6));
    setTimeout(() => void this.connect(), wait).unref();
  }

  stop() {
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    this.stream?.destroy();
  }
}
