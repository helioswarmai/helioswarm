// Live demo dashboard: `--dashboard [port]` on a trading run or a watch serves a page at
// http://localhost:<port> that shows the agents, their wallets and trades, the market feed,
// early (pre-execution) warnings and signals as they happen. Server-sent events, no deps.
import { createServer, type ServerResponse } from "node:http";

export interface DashboardAgent {
  id: string;
  preset: string;
  wallet?: string;
  bankrollSol: number;
}

export interface DashboardInfo {
  title: string;
  mode: "live" | "paper" | "watch";
  tokens: { mint: string; symbol: string }[];
  agents: DashboardAgent[];
}

export class Dashboard {
  private clients = new Set<ServerResponse>();
  private history: string[] = [];
  private server;

  constructor(private info: DashboardInfo, port: number) {
    this.server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      if (path.endsWith("/events")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
        res.write(`event: info\ndata: ${JSON.stringify(this.info)}\n\n`);
        for (const h of this.history) res.write(h);
        this.clients.add(res);
        req.on("close", () => this.clients.delete(res));
        return;
      }
      if (path === "/" || path.endsWith("/") || path.endsWith("/live")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      res.writeHead(404).end();
    });
    this.server.listen(port, "0.0.0.0", () => console.log(`\n  Dashboard: http://localhost:${port}\n`));
    const ping = setInterval(() => {
      for (const c of this.clients) c.write(": ping\n\n");
    }, 15_000);
    ping.unref();
  }

  push(line: Record<string, unknown>) {
    const msg = `data: ${JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`;
    this.history.push(msg);
    if (this.history.length > 600) this.history.splice(0, this.history.length - 600);
    for (const c of this.clients) c.write(msg);
  }

  close() {
    for (const c of this.clients) c.end();
    this.server.close();
  }
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Helioswarm Live</title>
<meta name="description" content="Helioswarm agents trading on Solana, live: every unit's wallet, position and trade as it happens.">
<meta name="theme-color" content="#000000">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23000000'/%3E%3Cellipse cx='16' cy='16' rx='13' ry='6' transform='rotate(-20 16 16)' fill='none' stroke='%23EEF0F2' stroke-width='1.5'/%3E%3Ccircle cx='16' cy='16' r='4' fill='%23FF8A3D'/%3E%3Crect x='25' y='9' width='4' height='4' fill='%23BFE9EC'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<style>
:root {
  color-scheme: dark;
  --bg: #000000; --fg: #EEF0F2; --muted: #9B9B9B; --dim: #5B5F66; --line: #2A2C30; --line-soft: rgba(42,44,48,0.6);
  --sun: #FF8A3D; --sun-core: #FFFFFF; --ice: #BFE9EC; 
  --g: 96px; --padl: 16px; --padr: 16px; --top: 96px;
  --sans: "Geist", "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --ease: cubic-bezier(0.32, 0.72, 0, 1);
}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; color: var(--fg); background: var(--bg); font-family: var(--sans); font-size: 16px; line-height: 24px; -webkit-font-smoothing: antialiased; overflow-x: hidden; position: relative; isolation: isolate; min-height: 100vh; }
h1, h2, p, dl, dd { margin: 0; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--ice); outline-offset: 3px; }
::selection { background: var(--sun); color: var(--bg); }
.grain { position: fixed; inset: 0; z-index: 40; pointer-events: none; opacity: 0.12;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
.wrap { position: relative; z-index: 2; padding-left: max(var(--padl), env(safe-area-inset-left, 0px)); padding-right: max(var(--padr), env(safe-area-inset-right, 0px)); }
.label { font-family: var(--mono); font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.label b { font-weight: 500; color: var(--fg); }
.sun { color: var(--sun); } .ice { color: var(--ice); } .dim { color: var(--dim); }

/* nav: bare, brand left, status right */
.nav { position: absolute; z-index: 50; left: 0; right: 0; top: 0; height: var(--top); display: flex; justify-content: space-between; align-items: center; gap: 16px;
  padding-left: max(var(--padl), env(safe-area-inset-left, 0px)); padding-right: max(var(--padr), env(safe-area-inset-right, 0px)); }
.brand { display: flex; align-items: center; gap: 8px; text-decoration: none; font-family: var(--mono); font-weight: 500; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; }
.brand svg { display: block; }
.status { display: inline-flex; align-items: center; gap: 8px; }
.blip { width: 8px; height: 8px; background: var(--dim); }
.on .blip { background: var(--sun); animation: blink 1.2s steps(2, start) infinite; }
@keyframes blink { to { visibility: hidden; } }
.btn { display: inline-flex; align-items: center; font-family: var(--mono); font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 8px 12px; border: 1px solid var(--line); background: rgba(0,0,0,0.6); color: var(--fg); text-decoration: none; cursor: pointer;
  transition: border-color 700ms var(--ease), background-color 700ms var(--ease), color 700ms var(--ease); }
.btn::before { content: "[ "; white-space: pre; } .btn::after { content: " ]"; white-space: pre; }
.btn:hover { border-color: var(--fg); }
.btn.solid { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.btn.solid:hover { background: var(--sun); border-color: var(--sun); }

/* console: the swarm map fills it, type sits in the corners */
.console { position: relative; z-index: 2; overflow: hidden; border-bottom: 1px solid var(--line); min-height: 640px; display: flex; }
#swarm { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.overlay { position: relative; flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto 1fr auto; gap: 24px;
  padding: var(--top) max(var(--padr), env(safe-area-inset-right, 0px)) 40px max(var(--padl), env(safe-area-inset-left, 0px)); pointer-events: none; }
.meta { align-self: start; margin: 0; padding-top: 8px; font-family: var(--mono); font-size: 12px; line-height: 20px; letter-spacing: 0.04em; color: var(--dim); white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.meta b { font-weight: 400; color: var(--fg); }
.meta .alert { color: var(--sun); }
.clock { padding-top: 8px; text-align: right; display: flex; flex-direction: column; gap: 4px; align-items: flex-end; font-family: var(--mono); font-size: 12px; line-height: 20px; letter-spacing: 0.04em; }
.clock strong { font-weight: 400; color: var(--fg); font-variant-numeric: tabular-nums; }
.legend { display: none; color: var(--muted); white-space: pre; }
.title { grid-row: 3; grid-column: 1 / -1; align-self: end; }
h1 { font-size: 30px; line-height: 36px; letter-spacing: -0.01em; font-weight: 500; text-transform: uppercase; }
h1 span { display: block; color: var(--muted); }
@media (min-width: 768px) { .legend { display: block; } h1 { font-size: 36px; line-height: 40px; } }
@media (min-width: 1024px) { h1 { font-size: 48px; line-height: 1; } }

/* readouts: one row on the grid, no boxes */
.readouts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-bottom: 1px solid var(--line); }
.ro { padding: 20px 0 24px; min-width: 0; }
.ro .v { font-family: var(--mono); font-size: 24px; line-height: 32px; margin-top: 8px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 899px) { .ro:nth-child(n+3) { border-top: 1px solid var(--line-soft); } }
@media (min-width: 900px) { .readouts { grid-template-columns: repeat(5, minmax(0, 1fr)); } }

/* main grid */
.panes { display: grid; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 1100px) { .panes { grid-template-columns: minmax(0, 1fr) var(--side, 400px); } .panes > .pane:first-child { border-right: 1px solid var(--line); padding-right: 32px; } .panes > .pane:last-child { padding-left: 32px; } }
.block { padding: 32px 0; border-bottom: 1px solid var(--line); }
.block:last-child { border-bottom: 0; }
.head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; min-height: 34px; }
#chart { width: 100%; height: 232px; display: block; }

/* units: a table on wide screens, stacked rows on narrow ones */
.units { display: flex; flex-direction: column; }
.urow { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 0.8fr) minmax(0, 0.9fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 1fr) 112px; gap: 16px; align-items: center;
  padding: 12px 0; border-bottom: 1px solid var(--line-soft); font-family: var(--mono); font-size: 12px; line-height: 16px; letter-spacing: 0.04em; position: relative; transition: background-color 1.2s var(--ease); }
.urow.thead { color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; padding-top: 0; border-bottom-color: var(--line); }
.urow .r { text-align: right; font-variant-numeric: tabular-nums; }
.urow .id { color: var(--fg); text-transform: uppercase; letter-spacing: 0.06em; display: flex; align-items: center; gap: 8px; min-width: 0; }
.urow .id span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.urow .cls { color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.urow .last { grid-column: 1 / -1; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: -4px; }
.urow .last::before { content: "> "; color: var(--sun); }
.sq { width: 8px; height: 8px; flex: none; border: 1px solid var(--fg); }
.urow.buy { background: rgba(191,233,236,0.06); } .urow.buy .sq { background: var(--ice); border-color: var(--ice); }
.urow.sell { background: rgba(255,138,61,0.07); } .urow.sell .sq { background: var(--sun); border-color: var(--sun); }
.urow.hl { background: rgba(255,255,255,0.04); }
.wallet { color: var(--ice); text-decoration: none; }
.wallet:hover { text-decoration: underline; }
.bar { display: grid; grid-template-columns: repeat(16, 1fr); gap: 2px; }
.bar i { height: 8px; background: var(--line); }
.bar i.on { background: var(--fg); } .bar.hot i.on { background: var(--sun); }
@media (max-width: 759px) {
  .urow.thead { display: none; }
  .urow { grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; }
  .urow .cls, .urow .wcell { color: var(--dim); }
  .urow .exp { grid-column: 1 / -1; }
  .urow > * { text-align: left; }
  .urow > :nth-child(even) { text-align: right; }
  .urow > .last { text-align: left; }
  .head .sub { display: none; }
}

/* feed */
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs .btn { padding: 4px 8px; }
.tabs .btn.on { border-color: var(--sun); color: var(--sun); }
.feed { max-height: 820px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.ev { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line-soft); font-family: var(--mono); font-size: 12px; line-height: 18px; letter-spacing: 0.02em; animation: in 1.2s var(--ease); }
@keyframes in { from { background: rgba(255,138,61,0.10); } to { background: transparent; } }
.ev .t { color: var(--dim); font-variant-numeric: tabular-nums; }
.ev.market { color: var(--muted); }
.ev a { color: var(--ice); text-decoration: none; }
.ev a:hover { text-decoration: underline; }
.k { text-transform: uppercase; letter-spacing: 0.08em; }
.k.buy { color: var(--ice); } .k.sell { color: var(--sun); }
.k.buy::before { content: "[+] "; } .k.sell::before { content: "[-] "; }
.who { color: var(--fg); text-transform: uppercase; letter-spacing: 0.06em; }
.early { color: var(--sun); }
.sig { display: inline-block; padding: 0 6px; border: 1px solid var(--sun); color: var(--sun); text-transform: uppercase; letter-spacing: 0.08em; margin-right: 8px; }
.sig.low { border-color: var(--ice); color: var(--ice); }
.empty { padding: 24px 0; color: var(--dim); font-family: var(--mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
.empty::before { content: "> "; color: var(--sun); }

/* card that follows a unit on the map */
.callout { position: absolute; left: 0; top: 0; width: 232px; z-index: 3; pointer-events: none; border: 1px solid var(--muted); background: rgba(0,0,0,0.86); padding: 12px;
  display: flex; flex-direction: column; gap: 8px; opacity: 0; transition: opacity 300ms var(--ease), border-color 700ms var(--ease); }
.callout.on { opacity: 1; }
.callout.alert { border-color: var(--sun); } .callout.ok { border-color: var(--ice); }
.callout-head { display: flex; justify-content: space-between; gap: 8px; }
.callout-title { font-family: var(--mono); font-size: 14px; line-height: 20px; text-transform: uppercase; letter-spacing: 0.04em; }
.callout dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
.callout dt, .callout dd { font-family: var(--mono); font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; }
.callout dt { color: var(--muted); } .callout dd { text-align: right; font-variant-numeric: tabular-nums; }

footer { position: relative; z-index: 2; border-top: 1px solid var(--line); }
.foot { padding-top: 32px; padding-bottom: 48px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.foot nav { display: flex; gap: 12px; }
@media (prefers-reduced-motion: reduce) { .ev, .on .blip { animation: none; } }
</style>
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<header class="nav">
  <a class="brand" href="https://helioswarm.xyz/" aria-label="Helioswarm home">
    <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="16" cy="16" rx="14" ry="6" transform="rotate(-20 16 16)" fill="none" stroke="#EEF0F2" stroke-width="1.5"/><circle cx="16" cy="16" r="4" fill="#FF8A3D"/><rect x="26" y="8" width="4" height="4" fill="#BFE9EC"/></svg>
    Helioswarm <span class="dim">/ Live</span>
  </a>
  <span class="label status" id="conn"><span class="blip"></span><span id="connTxt">connecting</span></span>
</header>

<main>
<section class="console" id="console">
  <canvas id="swarm" role="img" aria-label="The swarm's units as squares orbiting a dithered sun. A unit lights up when it trades."></canvas>
  <div class="callout" id="callout" aria-hidden="true"></div>
  <div class="overlay">
<pre class="meta">SWARM ....... <b>HELIOS-01</b>
UNITS ....... <b id="mUnits">-</b>
TARGET ...... <b id="mTarget">-</b>
MODE ........ <b id="mMode">-</b>
STATUS ...... <b id="mStatus">NOMINAL</b></pre>
    <div class="clock">
      <strong id="clock">T+0000</strong>
      <span class="legend" aria-hidden="true">[ ] HOLD   <span class="ice">[+] BUY</span>   <span class="sun">[-] SELL</span></span>
    </div>
    <div class="title"><h1>Many minds.<span>Trading live.</span></h1></div>
  </div>
</section>

<div class="wrap">
  <section class="readouts" aria-label="Swarm readouts">
    <div class="ro"><div class="label">Swarm P&amp;L</div><div class="v" id="sPnl">-</div></div>
    <div class="ro"><div class="label">Unit trades</div><div class="v" id="sTrades">00</div></div>
    <div class="ro"><div class="label">Market +/- 5m</div><div class="v" id="sMkt">0 / 0</div></div>
    <div class="ro"><div class="label">Seen pre-exec</div><div class="v" id="sEarly">-</div></div>
    <div class="ro"><div class="label">Price <span class="dim">SOL</span></div><div class="v" id="price">-</div></div>
  </section>

  <div class="panes">
    <div class="pane">
      <section class="block">
        <div class="head"><span class="label">Units <b id="agentCount"></b></span><span class="label dim sub">Own mind :: own wallet :: one board</span></div>
        <div class="units" id="agents"></div>
      </section>
      <section class="block">
        <div class="head"><span class="label"><b id="sym">-</b> / SOL &nbsp;<span id="chg"></span> <span class="dim">:: 10m</span></span><a class="btn" id="mintLink" target="_blank" rel="noopener">Token</a></div>
        <canvas id="chart"></canvas>
      </section>
    </div>
    <div class="pane">
      <section class="block">
        <div class="head"><span class="label">Feed</span>
          <span class="tabs"><button class="btn on" data-f="all">All</button><button class="btn" data-f="swarm">Units</button><button class="btn" data-f="early">Pre-exec</button></span></div>
        <div class="feed" id="feed"><div class="empty">Awaiting activity</div></div>
      </section>
    </div>
  </div>
</div>
</main>

<footer>
  <div class="wrap foot">
    <p class="label"><span class="sun">///</span> Every unit trades from its own public wallet</p>
    <nav aria-label="Footer"><a class="btn" href="https://helioswarm.xyz/">Home</a><a class="btn solid" href="https://github.com/helioswarmai/helioswarm" target="_blank" rel="noopener">GitHub</a></nav>
  </div>
</footer>
<script>
const $ = (id) => document.getElementById(id);
const short = (a) => a && a.length > 12 ? a.slice(0, 4) + "…" + a.slice(-4) : (a || "?");
const fmt = (n, d = 4) => Number(n).toFixed(d);
const big = (n) => { const a = Math.abs(n); return a >= 1e9 ? (n/1e9).toFixed(2)+"B" : a >= 1e6 ? (n/1e6).toFixed(2)+"M" : a >= 1e3 ? (n/1e3).toFixed(1)+"K" : n.toFixed(2); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const time = (ts) => { const d = ts ? new Date(ts) : new Date(); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour12: false }); };
const SIG = { whale_sell: "Whale sell", holder_moved: "Holder moved", sell_pressure: "Sell pressure", buy_pressure: "Buy pressure", pending_sell: "Big sell incoming", pending_move: "Holder about to move", pending_activity: "Holder active", note: "Note" };
// Preset traits (src/types.ts) set each class's orbit speed and direction on the map.
const PRESETS = { degen: { risk: 235, patience: 40, contrarian: 70 }, showman: { risk: 140, patience: 110, contrarian: 80 }, holder: { risk: 70, patience: 230, contrarian: 110 },
  contrarian: { risk: 150, patience: 160, contrarian: 235 }, momentum: { risk: 170, patience: 90, contrarian: 30 }, sniper: { risk: 190, patience: 25, contrarian: 90 } };
const RING_ORDER = ["degen", "showman", "holder", "contrarian", "momentum", "sniper"];

let info = null, filter = "all";
const agents = new Map();
const prices = [], marks = [], mkt = [], early = [];
let agentTrades = 0, lastPrice = 0, firstPrice = 0;
let pointer = null, hoverId = null, pulses = [], status = null, cardKey = "";
const t0 = Date.now();
const sym = (m) => (info?.tokens.find((t) => t.mint === m)?.symbol) || short(m);

function bar(frac, hot) {
  const n = Math.max(0, Math.min(16, Math.round(frac * 16)));
  return '<div class="bar' + (hot ? " hot" : "") + '">' + Array.from({ length: 16 }, (_, i) => '<i class="' + (i < n ? "on" : "") + '"></i>').join("") + "</div>";
}
function equityOf(a) { const posVal = a.tokens * lastPrice; const equity = a.cash + posVal; const pnl = equity - a.start; return { posVal, equity, pnl, pct: a.start > 0 ? (pnl / a.start) * 100 : 0 }; }
function signed(n, d) { return (n >= 0 ? "+" : "") + fmt(n, d); }

function renderAgents() {
  const el = $("agents");
  let html = '<div class="urow thead"><span>Unit</span><span>Class</span><span>Wallet</span><span class="r">SOL</span><span class="r">Holding</span><span class="r">P&amp;L</span><span>Exposure</span></div>';
  let total = 0, start = 0;
  for (const a of agents.values()) {
    const e = equityOf(a);
    total += e.equity; start += a.start;
    html += '<article class="urow' + (a.flash ? " " + a.flash : "") + (hoverId === a.id ? " hl" : "") + '" data-id="' + esc(a.id) + '">' +
      '<span class="id"><i class="sq"></i><span>' + esc(a.id) + "</span></span>" +
      '<span class="cls">' + esc(a.preset) + "</span>" +
      '<span class="wcell">' + (a.wallet ? '<a class="wallet" href="https://solscan.io/account/' + a.wallet + '" target="_blank" rel="noopener">' + short(a.wallet) + " ↗</a>" : '<span class="dim">paper</span>') + "</span>" +
      '<span class="r">' + fmt(a.cash) + "</span>" +
      '<span class="r">' + (a.tokens > 0 ? big(a.tokens) : '<span class="dim">—</span>') + "</span>" +
      '<span class="r ' + (e.pnl >= 0 ? "ice" : "sun") + '">' + signed(e.pnl) + ' <span class="dim">' + e.pct.toFixed(1) + "%</span></span>" +
      '<span class="exp">' + bar(e.equity > 0 ? e.posVal / e.equity : 0, a.flash === "sell") + "</span>" +
      '<span class="last">' + (a.last ? esc(a.last) : "watching") + "</span></article>";
  }
  el.innerHTML = html;
  $("agentCount").textContent = agents.size ? String(agents.size).padStart(2, "0") : "";
  const p = total - start;
  $("sPnl").innerHTML = start ? '<span class="' + (p >= 0 ? "ice" : "sun") + '">' + signed(p) + "</span>" : "—";
}

function drawChart() {
  const c = $("chart"), dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const now = Date.now(), from = now - 10 * 60_000, axis = 72, pw = w - axis;
  g.font = "10px 'Geist Mono', monospace"; g.textBaseline = "middle";
  const pts = prices.filter((p) => p.t >= from);
  if (pts.length < 2) { g.fillStyle = "#5B5F66"; g.fillText("> AWAITING TRADES", 4, h / 2); return; }
  let lo = Math.min(...pts.map((p) => p.p)), hi = Math.max(...pts.map((p) => p.p));
  if (hi === lo) { hi *= 1.01; lo *= 0.99; }
  const x = (t) => ((t - from) / (now - from)) * (pw - 8) + 4;
  const y = (p) => 12 + (1 - (p - lo) / (hi - lo)) * (h - 24);
  g.fillStyle = "#5B5F66"; g.textAlign = "right";
  for (let r = 0; r <= 4; r++) { const v = hi - (r / 4) * (hi - lo); g.fillText(v.toPrecision(4), w, 12 + (r / 4) * (h - 24)); }
  g.textAlign = "left";
  g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(x(p.t), y(p.p)) : g.moveTo(x(p.t), y(p.p)));
  g.strokeStyle = "#EEF0F2"; g.lineWidth = 1.5; g.stroke();
  for (const m of marks.filter((m) => m.t >= from)) { const s = 7; g.fillStyle = m.side === "buy" ? "#BFE9EC" : "#FF8A3D"; g.fillRect(x(m.t) - s / 2, y(m.p) - s / 2, s, s); }
  const last = pts[pts.length - 1];
  g.lineWidth = 1; g.strokeStyle = "rgba(255,138,61,0.5)"; g.setLineDash([2, 4]); g.beginPath(); g.moveTo(x(last.t), Math.round(y(last.p)) + 0.5); g.lineTo(pw, Math.round(y(last.p)) + 0.5); g.stroke(); g.setLineDash([]);
  g.fillStyle = "#FF8A3D"; g.fillRect(x(last.t) - 3, y(last.p) - 3, 6, 6);
}

function add(cls, html, ts, kind) {
  const feed = $("feed");
  if (feed.firstElementChild?.classList.contains("empty")) feed.innerHTML = "";
  const d = document.createElement("div");
  d.className = "ev " + cls;
  d.dataset.kind = kind;
  d.innerHTML = '<span class="t">' + time(ts) + "</span><span>" + html + "</span>";
  if (filter !== "all" && kind !== filter) d.style.display = "none";
  feed.prepend(d);
  while (feed.children.length > 400) feed.lastChild.remove();
}

function stats() {
  const cut = Date.now() - 5 * 60_000;
  while (mkt.length && mkt[0].t < cut) mkt.shift();
  $("sMkt").innerHTML = '<span class="ice">' + mkt.filter((m) => m.s === "buy").length + '</span> <span class="dim">/</span> <span class="sun">' + mkt.filter((m) => m.s === "sell").length + "</span>";
  const e = early.slice(-200).sort((a, b) => a - b);
  $("sEarly").innerHTML = e.length ? e[Math.floor(e.length / 2)] + '<span class="dim">ms</span>' : "—";
  $("sTrades").textContent = String(agentTrades).padStart(2, "0");
  if (lastPrice) {
    $("price").textContent = lastPrice.toPrecision(4);
    if (firstPrice) { const c = (lastPrice / firstPrice - 1) * 100; $("chg").innerHTML = '<span class="' + (c >= 0 ? "ice" : "sun") + '">' + (c >= 0 ? "+" : "") + c.toFixed(2) + "%</span>"; }
  }
  const s = Math.floor((Date.now() - t0) / 1000);
  $("clock").textContent = "T+" + String(Math.floor(s / 60)).padStart(4, "0");
}

// ---------- the swarm map ----------
const cv = $("swarm"), ctx = cv.getContext("2d"), card = $("callout"), consoleEl = $("console"), root = document.documentElement;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const C = { fg: "#EEF0F2", muted: "#9B9B9B", dim: "#5B5F66", sun: "#FF8A3D", core: "#FFFFFF", ice: "#BFE9EC", bg: "#000000" };
const MONO = "'Geist Mono', ui-monospace, monospace";
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
let rot = -0.32, sq = 0.46, W = 0, H = 0, U = 0, cx = 0, cy = 0, dpr = 1, G = 96, padL = 16, lastW = 0, mapT = 0, rings = 3;
let seed = 11;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const stars = Array.from({ length: 200 }, () => [rnd(), rnd(), rnd()]);

function orbitSetup() {
  const rank = (c) => { const i = RING_ORDER.indexOf(c); return i < 0 ? 99 : i; };
  const classes = [...new Set([...agents.values()].map((a) => a.preset))].sort((a, b) => rank(a) - rank(b));
  rings = Math.max(3, classes.length);
  const per = {};
  for (const a of agents.values()) (per[a.preset] = per[a.preset] || []).push(a);
  classes.forEach((c, ci) => {
    const t = PRESETS[c] || { risk: 140, patience: 120, contrarian: 100 };
    const ring = classes.length < rings ? Math.round((ci + 0.5) * rings / classes.length - 0.5) : ci;
    per[c].forEach((a, k) => {
      a.ring = ring;
      a.ang = (k / per[c].length) * Math.PI * 2 + ci * 0.9 + rnd() * 0.4;
      a.w = (0.04 + (1 - t.patience / 255) * 0.18) * (t.contrarian > 128 ? -1 : 1) * (0.85 + rnd() * 0.3);
      a.amp = t.risk / 255 * 0.06; a.ph = rnd() * 6.28; a.flashT = -9; a.x = 0; a.y = 0;
    });
  });
}
function ringRx(i) { return U * (0.16 + 0.3 * i / Math.max(1, rings - 1)); }
function place(a) {
  const rx = ringRx(a.ring) * (1 + a.amp * Math.sin(a.ang * 3 + a.ph + mapT * 0.7)), ry = rx * sq;
  const px = rx * Math.cos(a.ang), py = ry * Math.sin(a.ang);
  a.x = cx + px * Math.cos(rot) - py * Math.sin(rot); a.y = cy + px * Math.sin(rot) + py * Math.cos(rot);
}

// one square grid for the page, the same rule as helioswarm.xyz
function layout() {
  const vw = root.clientWidth, pad = vw >= 768 ? 40 : 16, n = Math.max(3, Math.round((vw - pad * 2) / 96));
  G = Math.floor((vw - pad * 2) / n); padL = Math.floor((vw - n * G) / 2);
  root.style.setProperty("--g", G + "px"); root.style.setProperty("--padl", padL + "px"); root.style.setProperty("--padr", (vw - n * G - padL) + "px");
  root.style.setProperty("--side", (n >= 14 ? 5 : 4) * G + "px");
  const rows = vw >= 768 ? Math.max(5, Math.min(6, Math.round((innerHeight * 0.72 - 96 - 40) / G))) : 6;
  consoleEl.style.minHeight = (96 + rows * G + 40) + "px";
  lastW = vw;
}
const snapX = (x) => padL + Math.round((x - padL) / G) * G;
const snapY = (y) => 96 + Math.round((y - 96) / G) * G;
function resize() {
  if (root.clientWidth !== lastW) layout();
  const r = consoleEl.getBoundingClientRect(), wide = r.width >= 1024;
  dpr = Math.min(devicePixelRatio || 1, 2); W = r.width; H = r.height;
  cx = snapX(W * (wide ? 0.64 : 0.5)); cy = wide ? snapY(H * 0.46) : Math.round(H * 0.5);
  U = (wide ? Math.min(W * 0.3, H * 0.66) : Math.min(W * 0.62, H * 0.3)) / 0.46;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  drawMap(); drawChart();
}
function drawSun(coreOnly) {
  const cell = W < 700 ? 3 : 4, R = U * 0.028, ext = U * 0.12, n = Math.ceil(ext / cell);
  for (let gy = -n; gy <= n; gy++) for (let gx = -n; gx <= n; gx++) {
    const x = gx * cell, y = gy * cell, d = Math.sqrt(x * x + y * y);
    if (d > ext) continue;
    if (d < R) { if (coreOnly) { ctx.fillStyle = C.core; ctx.fillRect(cx + x, cy + y, cell, cell); } continue; }
    if (coreOnly) continue;
    let v = 1 - (d - R) / (ext - R);
    v = v * v * (0.82 + 0.18 * Math.sin(mapT * 0.9 - d * 0.06));
    if (v > (BAYER[(gx & 3) + ((gy & 3) << 2)] + 0.5) / 16) { ctx.fillStyle = C.sun; ctx.fillRect(cx + x, cy + y, cell - 1, cell - 1); }
  }
}
function drawMap() {
  if (!W) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  // registration marks where the page grid crosses (the only grid on the page)
  ctx.lineWidth = 1; ctx.strokeStyle = C.muted; ctx.globalAlpha = 0.4; ctx.beginPath();
  for (let x = padL; x <= W; x += G) for (let y = 96; y <= H; y += G) { ctx.moveTo(x - 3, y + 0.5); ctx.lineTo(x + 4, y + 0.5); ctx.moveTo(x + 0.5, y - 3); ctx.lineTo(x + 0.5, y + 4); }
  ctx.stroke();
  for (const s of stars) { ctx.globalAlpha = 0.2 + 0.5 * s[2]; const b = s[2] > 0.85 ? 2 : 1; ctx.fillStyle = C.muted; ctx.fillRect(Math.round(s[0] * W), Math.round(s[1] * H), b, b); }
  const list = [...agents.values()];
  for (const a of list) place(a);
  ctx.strokeStyle = C.muted; ctx.globalAlpha = 0.13; ctx.beginPath();
  for (const a of list) { ctx.moveTo(a.x, a.y); ctx.lineTo(cx, cy); }
  ctx.stroke();
  for (let i = 0; i < rings; i++) { const rx = ringRx(i); ctx.strokeStyle = C.dim; ctx.globalAlpha = 0.7; ctx.setLineDash(i % 2 ? [2, 5] : []); ctx.beginPath(); ctx.ellipse(cx, cy, rx, rx * sq, rot, 0, Math.PI * 2); ctx.stroke(); }
  ctx.setLineDash([]); ctx.globalAlpha = 1;
  drawSun(false);
  for (const p of pulses) { const age = mapT - p, pr = U * 0.55 * age / 2.4; ctx.strokeStyle = C.sun; ctx.globalAlpha = Math.max(0, 1 - age / 2.4); ctx.beginPath(); ctx.ellipse(cx, cy, pr, pr * sq, rot, 0, Math.PI * 2); ctx.stroke(); }
  ctx.globalAlpha = 1;
  const size = W < 700 ? 5 : 6, names = list.length <= 16;
  ctx.font = "10px " + MONO; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  for (const a of list) {
    const f = mapT - a.flashT, col = a.flash === "buy" ? C.ice : a.flash === "sell" ? C.sun : C.fg;
    if (f > 0 && f < 1.2) {
      const k = f / 1.2;
      ctx.strokeStyle = col; ctx.globalAlpha = 1 - k; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(cx, cy); ctx.stroke();
      ctx.fillStyle = col; ctx.globalAlpha = 1; ctx.fillRect(Math.round(a.x + (cx - a.x) * k) - 1, Math.round(a.y + (cy - a.y) * k) - 1, 3, 3);
    }
    const hx = Math.round(a.x - size / 2), hy = Math.round(a.y - size / 2);
    ctx.globalAlpha = 1; ctx.fillStyle = C.bg; ctx.fillRect(hx - 1, hy - 1, size + 2, size + 2);
    if (!a.flash) { ctx.strokeStyle = C.fg; ctx.strokeRect(hx + 0.5, hy + 0.5, size - 1, size - 1); } else { ctx.fillStyle = col; ctx.fillRect(hx, hy, size, size); }
    let alpha = names ? 0.75 : 0;
    if (pointer) { const d = Math.hypot(a.x - pointer.x, a.y - pointer.y); if (d < 150) alpha = Math.max(alpha, (1 - d / 150) * 0.9); }
    if (alpha > 0 && a.id !== hoverId) { ctx.globalAlpha = alpha; ctx.fillStyle = a.flash ? col : C.muted; ctx.fillText(String(a.id).toUpperCase(), a.x + size + 5, a.y + 0.5); }
  }
  ctx.globalAlpha = 1;
  drawSun(true);
  const fa = hoverId ? agents.get(hoverId) : null;
  if (fa) {
    const q = size + 6, bx = Math.round(fa.x) + 0.5, by = Math.round(fa.y) + 0.5, c4 = 4;
    ctx.strokeStyle = C.fg; ctx.beginPath();
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach((m) => { ctx.moveTo(bx + m[0] * q, by + m[1] * (q - c4)); ctx.lineTo(bx + m[0] * q, by + m[1] * q); ctx.lineTo(bx + m[0] * (q - c4), by + m[1] * q); });
    ctx.stroke();
  }
  placeCard(fa);
}
function setCard(a) {
  if (!a) { if (cardKey) { cardKey = ""; card.className = "callout"; } return; }
  const e = equityOf(a), st = a.flash || "hold";
  const key = a.id + st + fmt(a.cash) + a.tokens + (a.last || "") + e.pnl.toFixed(4);
  if (key === cardKey) return;
  cardKey = key;
  card.className = "callout on" + (a.flash === "sell" ? " alert" : a.flash === "buy" ? " ok" : "");
  card.innerHTML = '<div class="callout-head"><span class="label">Unit :: ' + esc(a.preset) + '</span><span class="label ' + (st === "buy" ? "ice" : st === "sell" ? "sun" : "") + '">[ ' + st + " ]</span></div>" +
    '<p class="callout-title">' + esc(a.id) + "</p>" +
    "<dl><dt>SOL</dt><dd>" + fmt(a.cash) + "</dd><dt>Holding</dt><dd>" + (a.tokens > 0 ? big(a.tokens) : "—") + "</dd><dt>P&amp;L</dt><dd class='" + (e.pnl >= 0 ? "ice" : "sun") + "'>" + signed(e.pnl) + "</dd></dl>" +
    '<p class="label dim">&gt; ' + (a.last ? esc(a.last) : "watching") + "</p>";
}
function placeCard(a) {
  setCard(a);
  if (!a) return;
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let x = a.x + 22, y = a.y - ch - 14;
  if (x + cw > W - 12) x = a.x - cw - 22;
  if (y < 76) y = a.y + 22;
  x = Math.max(12, Math.min(W - cw - 12, x)); y = Math.max(76, Math.min(H - ch - 12, y));
  card.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
}
function setStatus(text, alert) { const el = $("mStatus"); el.textContent = text; el.className = alert ? "alert" : ""; }
function pick() {
  let best = null, bd = 26 * 26;
  for (const a of agents.values()) { const d = (a.x - pointer.x) ** 2 + (a.y - pointer.y) ** 2; if (d < bd) { bd = d; best = a; } }
  setHover(best ? best.id : null);
}
function setHover(id) { if (id === hoverId) return; hoverId = id; for (const r of $("agents").children) r.classList.toggle("hl", !!id && r.dataset.id === id); }
function at(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
consoleEl.addEventListener("pointermove", (e) => { pointer = at(e); pick(); if (!running) drawMap(); });
consoleEl.addEventListener("pointerleave", () => { pointer = null; setHover(null); if (!running) drawMap(); });
$("agents").addEventListener("pointerover", (e) => { const r = e.target.closest(".urow[data-id]"); setHover(r ? r.dataset.id : null); if (!running) drawMap(); });
$("agents").addEventListener("pointerleave", () => { setHover(null); if (!running) drawMap(); });

let last = 0, running = false, visible = true;
function frame(now) {
  if (!running) return;
  const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now; mapT += dt;
  for (const a of agents.values()) a.ang += a.w * dt;
  while (pulses.length && mapT - pulses[0] > 2.4) pulses.shift();
  if (status && mapT > status) { status = null; setStatus("NOMINAL", false); }
  drawMap();
  requestAnimationFrame(frame);
}
function setRunning(on) { on = on && !reduce; if (on && !running) { running = true; last = performance.now(); requestAnimationFrame(frame); } else if (!on) running = false; }

function onEvent(l) {
  const ts = l.ts;
  switch (l.event) {
    case "wallet": {
      const a = agents.get(l.agent); if (!a) return;
      a.cash = Number(l.tradableSol); a.start = a.cash; a.wallet = l.address || a.wallet; renderAgents(); return;
    }
    case "fill": {
      const a = agents.get(l.agent);
      const buy = l.side === "buy";
      agentTrades++;
      if (a) {
        if (buy) { a.cash -= Number(l.sol); a.tokens += Number(l.tokens); } else { a.cash += Number(l.sol); a.tokens = Math.max(0, a.tokens - Number(l.tokens)); }
        a.last = (buy ? "bought " : "sold ") + fmt(l.sol) + " SOL" + (l.reason && l.reason !== "on-chain" ? " · " + l.reason : "");
        a.flash = buy ? "buy" : "sell"; a.flashT = mapT;
        clearTimeout(a.flashTimer); a.flashTimer = setTimeout(() => { a.flash = null; renderAgents(); if (!running) drawMap(); }, 2400);
      }
      if (l.priceSol) { lastPrice = Number(l.priceSol); if (!firstPrice) firstPrice = lastPrice; marks.push({ t: Date.now(), p: lastPrice, side: l.side }); prices.push({ t: Date.now(), p: lastPrice }); }
      const link = l.sig && l.sig !== "paper" ? ' <a href="https://solscan.io/tx/' + l.sig + '" target="_blank" rel="noopener">tx ↗</a>' : ' <span class="dim">paper</span>';
      add("swarm", '<span class="who">' + esc(l.agent) + '</span> <span class="k ' + (buy ? "buy" : "sell") + '">' + (buy ? "buy" : "sell") + "</span> " + fmt(l.sol) + " SOL <span class='dim'>" + big(Number(l.tokens)) + " " + esc(sym(l.mint)) + (l.reason && l.reason !== "on-chain" ? " · " + esc(l.reason) : "") + "</span>" + link, ts, "swarm");
      renderAgents(); stats(); return;
    }
    case "refused": { const a = agents.get(l.agent); if (a) { a.last = "skip: " + l.why; renderAgents(); } return; }
    case "signal": {
      add("", '<span class="sig ' + (l.severity === "high" ? "" : "low") + '">' + esc(SIG[l.kind] || l.kind) + "</span>" + esc((l.reasons || []).join(" · ")), ts, "swarm");
      pulses.push(mapT); setStatus("SIGNAL :: " + String(l.kind || "").toUpperCase(), l.severity === "high"); status = mapT + 6;
      return;
    }
    case "flow": {
      if (l.kind !== "buy" && l.kind !== "sell") return;
      const buy = l.kind === "buy";
      if (l.priceSol) { lastPrice = Number(l.priceSol); if (!firstPrice) firstPrice = lastPrice; prices.push({ t: Date.now(), p: lastPrice }); if (prices.length > 4000) prices.shift(); }
      mkt.push({ t: Date.now(), s: l.kind });
      if (l.seenEarlyMs != null && l.seenEarlyMs >= 0) early.push(l.seenEarlyMs);
      const e = l.seenEarlyMs != null && l.seenEarlyMs >= 0 ? ' <span class="early">⚡' + l.seenEarlyMs + "ms</span>" : "";
      add("market", '<span class="k ' + (buy ? "buy" : "sell") + '">' + (buy ? "buy" : "sell") + "</span> " + fmt(l.sol) + " SOL <span class='dim'>" + big(Number(l.tokens)) + " · " + short(l.owner) + "</span>" + e, ts, "market");
      stats(); return;
    }
    case "pending": {
      if (l.kind !== "buy" && l.kind !== "sell") return;
      add("market", '<span class="early">⏳ incoming</span> <span class="k ' + l.kind + '">' + l.kind + '</span> <span class="dim">' + short(l.owner) + " · " + esc(l.venue) + " · not executed yet</span>", ts, "early");
      return;
    }
    case "task_error": { const a = agents.get(l.agent); if (a) { a.last = "error: " + String(l.error).slice(0, 80); renderAgents(); } return; }
  }
}

function connect() {
  const es = new EventSource("events");
  es.addEventListener("info", (m) => {
    info = JSON.parse(m.data);
    agents.clear();
    for (const a of info.agents) agents.set(a.id, { ...a, cash: a.bankrollSol, start: a.bankrollSol, tokens: 0, last: "" });
    orbitSetup();
    const t = info.tokens[0];
    if (t) { $("sym").textContent = t.symbol || short(t.mint); $("mTarget").textContent = (t.symbol || "") + " " + short(t.mint); $("mintLink").href = "https://solscan.io/token/" + t.mint; }
    const presets = new Set(info.agents.map((a) => a.preset));
    $("mUnits").textContent = String(info.agents.length).padStart(2, "0") + " / " + presets.size + (presets.size === 1 ? " CLASS" : " CLASSES");
    $("mMode").innerHTML = info.mode === "live" ? '<span class="sun">LIVE :: REAL SOL</span>' : info.mode === "paper" ? "PAPER" : "WATCH";
    $("feed").innerHTML = '<div class="empty">Awaiting activity</div>';
    renderAgents(); drawMap();
  });
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onopen = () => { $("conn").classList.add("on"); $("connTxt").textContent = "live"; };
  es.onerror = () => { $("conn").classList.remove("on"); $("connTxt").textContent = "reconnecting"; };
}
document.querySelectorAll(".tabs .btn").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".tabs .btn").forEach((x) => x.classList.toggle("on", x === b));
  filter = b.dataset.f;
  for (const ev of $("feed").children) ev.style.display = filter === "all" || ev.dataset.kind === filter ? "" : "none";
});
setInterval(() => { drawChart(); stats(); }, 1000);
if ("ResizeObserver" in window) new ResizeObserver(resize).observe(consoleEl); else addEventListener("resize", resize);
layout(); resize();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { drawMap(); drawChart(); });
if ("IntersectionObserver" in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; setRunning(visible && !document.hidden); }).observe(cv);
document.addEventListener("visibilitychange", () => setRunning(visible && !document.hidden));
setRunning(true);
connect();
</script>
</body>
</html>`;
