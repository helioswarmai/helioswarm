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
