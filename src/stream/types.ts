// Stream settings, kept apart from svs.ts so loading a config never loads the native gRPC client.
export interface StreamConfig {
  kind: "svs";
  endpoint: string;
  /** Env var holding the SVS x-token. */
  tokenEnv: string;
  /** Extra accounts to include, e.g. pool or bonding-curve addresses. */
  accounts: string[];
  commitment: "processed" | "confirmed";
  /** Load supply and the largest holders over RPC at startup (needs SOLANA_RPC_URL). */
  snapshot: boolean;
}

export const DEFAULT_STREAM: Omit<StreamConfig, "endpoint"> = { kind: "svs", tokenEnv: "SVS_X_TOKEN", accounts: [], commitment: "processed", snapshot: true };
