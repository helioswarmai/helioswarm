// Records executed + deshred txs for one mint and matches them by signature.
import { SvsStream, DeshredStream } from "../src/stream/svs";
import { DEFAULT_STREAM } from "../src/stream/types";
const mint = process.argv[2]!;
const secs = Number(process.argv[3] ?? 90);
const cfg = { ...DEFAULT_STREAM, endpoint: "https://basic.grpc.solanavibestation.com" };
const exec = new Map<string, { t: number; programs: string[] }>();
const pend = new Map<string, { t: number; programs: string[]; disc: string[]; nIx: number; keys: number }>();
const s = new SvsStream(cfg as never, [mint]);
const d = new DeshredStream(cfg as never, [mint]);
s.on("tx", (tx: any) => { if (!exec.has(tx.signature)) exec.set(tx.signature, { t: Date.now(), programs: [] }); });
s.on("status", (m: string) => console.error("[exec]", m));
d.on("status", (m: string) => console.error("[deshred]", m));
s.on("error", (e: Error) => console.error("[exec err]", e.message));
d.on("error", (e: Error) => console.error("[deshred err]", e.message));
d.on("pending", (tx: any) => {
  if (pend.has(tx.signature)) return;
  pend.set(tx.signature, { t: Date.now(), nIx: tx.instructions.length, keys: tx.accountKeys.length,
    programs: tx.instructions.map((i: any) => i.programId),
    disc: tx.instructions.map((i: any) => `${i.programId.slice(0, 6)}:${Buffer.from(i.data.slice(0, 8)).toString("hex")}:${i.accounts.length}`) });
});
await s.start?.(); d.start();
setTimeout(() => {
  const both = [...exec.keys()].filter((k) => pend.has(k));
  const lead = both.map((k) => exec.get(k)!.t - pend.get(k)!.t).sort((a, b) => a - b);
  console.log(JSON.stringify({ executed: exec.size, deshred: pend.size, matched: both.length, onlyExecuted: exec.size - both.length, onlyDeshred: pend.size - both.length,
    leadMs: lead.length ? { min: lead[0], median: lead[Math.floor(lead.length / 2)], max: lead.at(-1) } : null }));
  const progCount = new Map<string, number>();
  for (const p of pend.values()) for (const pr of new Set(p.programs)) progCount.set(pr, (progCount.get(pr) ?? 0) + 1);
  console.log("programs in deshred txs:", [...progCount].sort((a, b) => b[1] - a[1]));
  for (const [sig, p] of [...pend].slice(0, 12)) console.log(sig.slice(0, 10), exec.has(sig) ? "matched" : "unmatched", p.disc.join(" | "));
  process.exit(0);
}, secs * 1000);
