/**
 * Static "Toplist" report generator -- the local-first counterpart to the Next.js app's Top
 * Selected page: no server, no extra dependency, just fs + the Prisma client this repo already
 * has. Meant to run right after the nightly pipeline (Task Scheduler: `npm run refresh && npm run
 * toplist`) and produce a file you can double-click open in any browser, today or a year from now,
 * with nothing else running.
 *
 *   npx tsx scripts/toplist.ts
 *   REPORTS_OUT_DIR="D:\Secondbrain\SocialMedia\reports" npx tsx scripts/toplist.ts   (embed into the vault)
 *
 * Writes:
 *   <OUT_DIR>/toplist.html -- the full ranked report (always overwritten)
 *   <OUT_DIR>/index.html   -- a small dashboard; created fresh if missing, otherwise only the
 *                             <!-- toplist-card:start/end --> block is replaced in place, so other
 *                             future static reports (IDS, universe) can add their own card via the
 *                             same marker pattern without this script clobbering them.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import path from "path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { computeConsensus, DEFAULT_TRUST_WEIGHTS, type ConsensusInput } from "../lib/consensus";
import type { StockReport } from "../lib/report/types";

const OUT_DIR = process.env.REPORTS_OUT_DIR ?? path.join(process.cwd(), "reports");
const CARD_START = "<!-- toplist-card:start -->";
const CARD_END = "<!-- toplist-card:end -->";

interface ToplistRow {
  rank: number;
  ticker: string;
  name: string;
  sector: string | null;
  price: number | null;
  currency: string | null;
  priceChangePct1d: number | null;
  consensusScore: number | null;
  methodPercentiles: Partial<Record<string, number>>;
  decision: string | null;
  conviction: number | null;
}

const SAMPLE_ROWS: ToplistRow[] = [
  { rank: 1, ticker: "SAMPLE.US", name: "Sample Corp (run the pipeline for real data)", sector: "Technology", price: 123.45, currency: "USD", priceChangePct1d: 1.2, consensusScore: 82.4, methodPercentiles: { snowflake: 88, momentum: 70, magicFormula: 90, neff: 65, lynchPeg: 75, turtle: 100 }, decision: "GO", conviction: 4 },
  { rank: 2, ticker: "DEMO.BK", name: "Demo Public Company (sample)", sector: "Financial Services", price: 45.5, currency: "THB", priceChangePct1d: -0.4, consensusScore: 71.1, methodPercentiles: { snowflake: 74, momentum: 55, magicFormula: 68, neff: 80 }, decision: "WAIT", conviction: 3 },
  { rank: 3, ticker: "TEST.HK", name: "Test Holdings (sample)", sector: "Industrials", price: 8.9, currency: "HKD", priceChangePct1d: 0.0, consensusScore: 54.3, methodPercentiles: { snowflake: 50, momentum: 40, lynchPeg: 60 }, decision: null, conviction: null },
];

async function queryRealRows(): Promise<ToplistRow[]> {
  const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const stocks = await prisma.stock.findMany({
      where: { isActive: true, latestOverallScore: { not: null } },
      select: {
        id: true, ticker: true, name: true, sector: true, price: true, currency: true, priceChangePct1d: true,
        latestOverallScore: true, latestMomentumScore: true, roa: true, evToEbitda: true,
        estEarningsGrowth: true, dividendYield: true, peRatio: true, pegRatio: true,
      },
    });
    if (stocks.length === 0) return [];

    // Latest ResearchReport per ticker, for the Turtle lens + the Verdict column -- same
    // dedupe-by-recency pattern as app/page.tsx and app/top-selected/page.tsx.
    const reports = await prisma.researchReport.findMany({
      where: { ticker: { in: stocks.map((s) => s.ticker) } },
      orderBy: [{ ticker: "asc" }, { dataAsOf: "desc" }, { createdAt: "desc" }],
      select: { ticker: true, decision: true, conviction: true, payload: true },
    });
    const reportByTicker = new Map<string, (typeof reports)[number]>();
    for (const r of reports) if (!reportByTicker.has(r.ticker)) reportByTicker.set(r.ticker, r);

    const consensusInputs: ConsensusInput[] = stocks.map((s) => {
      const report = reportByTicker.get(s.ticker);
      const payload = report?.payload as unknown as StockReport | undefined;
      return {
        id: s.id,
        latestOverallScore: s.latestOverallScore,
        latestMomentumScore: s.latestMomentumScore,
        roa: s.roa,
        evToEbitda: s.evToEbitda,
        estEarningsGrowth: s.estEarningsGrowth,
        dividendYield: s.dividendYield,
        peRatio: s.peRatio,
        pegRatio: s.pegRatio,
        turtleConfirmed: payload?.turtleSignal?.confirmed ?? null,
      };
    });

    const consensus = computeConsensus(consensusInputs, DEFAULT_TRUST_WEIGHTS);
    const consensusById = new Map(consensus.map((c) => [c.id, c]));

    const rows: ToplistRow[] = stocks.map((s) => {
      const c = consensusById.get(s.id)!;
      const report = reportByTicker.get(s.ticker);
      return {
        rank: 0, // assigned after sort
        ticker: s.ticker,
        name: s.name,
        sector: s.sector,
        price: s.price,
        currency: s.currency,
        priceChangePct1d: s.priceChangePct1d,
        consensusScore: c.consensusScore,
        methodPercentiles: c.methodPercentiles,
        decision: report?.decision ?? null,
        conviction: report?.conviction ?? null,
      };
    });

    rows.sort((a, b) => (b.consensusScore ?? -Infinity) - (a.consensusScore ?? -Infinity));
    rows.forEach((r, i) => (r.rank = i + 1));
    return rows;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderToplistHtml(rows: ToplistRow[], isSample: boolean, generatedAt: string): string {
  const jsonPayload = JSON.stringify({ rows, isSample, generatedAt, weights: DEFAULT_TRUST_WEIGHTS });
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>akeguru — Toplist</title>
<style>
  :root{ --paper:#F6F7F5; --card:#FFFFFF; --ink:#182230; --ink-soft:#4A5568; --ink-faint:#8A94A3; --line:#E3E6E1;
    --brand:#0E5A63; --go:#1B7F4D; --go-bg:#E7F4EC; --wait:#A3690B; --wait-bg:#FBF1DC; --nogo:#B23A2E; --nogo-bg:#F9E9E7;
    --mono:'Consolas','SFMono-Regular',monospace; --sans:-apple-system,'Segoe UI',sans-serif; }
  *{box-sizing:border-box} body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:14px}
  .wrap{max-width:1180px;margin:0 auto;padding:24px 20px 60px}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--ink-soft);font-size:13px;margin:0 0 16px}
  .sample-banner{background:var(--wait-bg);color:var(--wait);border:1px solid var(--wait);border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px;font-weight:600}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
  th{text-align:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint);padding:10px 8px;border-bottom:1px solid var(--line)}
  th.left,td.left{text-align:left}
  td{padding:10px 8px;text-align:center;border-bottom:1px solid var(--line);vertical-align:middle}
  tr:last-child td{border-bottom:0} tbody tr:hover td{background:#FAFBF9}
  .sym{font-family:var(--mono);font-weight:700;color:var(--brand)} .co{font-size:11.5px;color:var(--ink-soft)}
  .comp{font-family:var(--mono);font-weight:700;background:var(--ink);color:#fff;border-radius:5px;padding:4px 8px;display:inline-block;min-width:42px}
  .bars{display:flex;gap:2px;justify-content:center}
  .bar{width:5px;border-radius:1px;background:var(--line)} .bar.on{background:var(--brand)}
  .stamp{font-family:var(--mono);font-size:10px;font-weight:700;padding:3px 7px;border:1.3px solid;border-radius:4px}
  .stamp.go{color:var(--go);border-color:var(--go);background:var(--go-bg)}
  .stamp.wait{color:var(--wait);border-color:var(--wait);background:var(--wait-bg)}
  .stamp.no_go{color:var(--nogo);border-color:var(--nogo);background:var(--nogo-bg)}
  .chg-up{color:var(--go)} .chg-dn{color:var(--nogo)} .muted{color:var(--ink-faint)}
  .legend{margin-top:14px;font-size:11px;color:var(--ink-faint);font-family:var(--mono)}
  footer{margin-top:20px;font-size:11.5px;color:var(--ink-faint)}
  a{color:var(--brand)}
</style>
</head>
<body>
<div class="wrap">
  <h1>Toplist — Consensus Ranking</h1>
  <p class="sub">Consensus = weighted blend of each stock's percentile rank across Snowflake / Momentum / Magic Formula-style / Neff / Lynch PEG / Turtle confirmation. Generated ${esc(generatedAt)}. <a href="index.html">← dashboard</a></p>
  <div id="banner"></div>
  <table id="tbl">
    <thead>
      <tr>
        <th class="left">#</th><th class="left">Symbol</th><th>Price</th><th>Chg%</th><th>Consensus</th>
        <th>Lens breakdown</th><th>Verdict</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
  <div class="legend">Lens breakdown bars, left→right: Snowflake · Momentum · Magic Formula · Neff · Lynch PEG · Turtle (blank = no data for that lens on this stock, weight redistributed among the rest)</div>
  <footer>akeguru toplist — local-first static export, zero server dependency.</footer>
</div>
<script type="application/json" id="toplist-data">${jsonPayload.replace(/</g, "\\u003c")}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('toplist-data').textContent);
  if (data.isSample) {
    document.getElementById('banner').innerHTML = '<div class="sample-banner">⚠ SAMPLE DATA — run the pipeline (npm run refresh) then npm run toplist for real results.</div>';
  }
  var methodOrder = ['snowflake', 'momentum', 'magicFormula', 'neff', 'lynchPeg', 'turtle'];
  var tbody = document.getElementById('tbody');
  data.rows.forEach(function (r) {
    var tr = document.createElement('tr');
    var bars = methodOrder.map(function (m) {
      var v = r.methodPercentiles[m];
      var h = v == null ? 3 : Math.max(3, Math.round(v / 100 * 16));
      return '<div class="bar' + (v == null ? '' : ' on') + '" style="height:' + h + 'px" title="' + m + (v == null ? ': no data' : ': ' + Math.round(v) + 'th pct') + '"></div>';
    }).join('');
    var chg = r.priceChangePct1d;
    var chgHtml = chg == null ? '<span class="muted">—</span>' : '<span class="' + (chg >= 0 ? 'chg-up' : 'chg-dn') + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%</span>';
    var priceHtml = r.price == null ? '<span class="muted">—</span>' : r.price.toLocaleString(undefined, {maximumFractionDigits: 2}) + ' ' + (r.currency || '');
    var verdictHtml = r.decision ? '<span class="stamp ' + r.decision.toLowerCase() + '">' + (r.decision === 'NO_GO' ? 'NO-GO' : r.decision) + '</span>' : '<span class="muted">—</span>';
    tr.innerHTML =
      '<td class="left">' + r.rank + '</td>' +
      '<td class="left"><div class="sym">' + r.ticker + '</div><div class="co">' + r.name + (r.sector ? ' · ' + r.sector : '') + '</div></td>' +
      '<td>' + priceHtml + '</td>' +
      '<td>' + chgHtml + '</td>' +
      '<td><span class="comp">' + (r.consensusScore == null ? '—' : r.consensusScore.toFixed(1)) + '</span></td>' +
      '<td><div class="bars">' + bars + '</div></td>' +
      '<td>' + verdictHtml + '</td>';
    tbody.appendChild(tr);
  });
})();
</script>
</body>
</html>
`;
}

function renderCardHtml(rows: ToplistRow[], isSample: boolean, generatedAt: string): string {
  const top = rows[0];
  return `${CARD_START}
    <a href="toplist.html" style="text-decoration:none;color:inherit">
      <div style="background:#fff;border:1px solid #E3E6E1;border-radius:10px;padding:16px;font-family:-apple-system,'Segoe UI',sans-serif">
        <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#8A94A3">Toplist</div>
        <div style="font-size:20px;font-weight:700;color:#182230;margin-top:4px">${rows.length} stocks ranked</div>
        <div style="font-size:12.5px;color:#4A5568;margin-top:4px">${top ? `#1 ${esc(top.ticker)} — consensus ${top.consensusScore?.toFixed(1) ?? "—"}` : "no data yet"}${isSample ? " (sample data)" : ""}</div>
        <div style="font-size:11px;color:#8A94A3;margin-top:8px;font-family:Consolas,monospace">${esc(generatedAt)}</div>
      </div>
    </a>
  ${CARD_END}`;
}

function writeIndexHtml(cardHtml: string): void {
  const indexPath = path.join(OUT_DIR, "index.html");
  if (existsSync(indexPath)) {
    const existing = readFileSync(indexPath, "utf8");
    const startIdx = existing.indexOf(CARD_START);
    const endIdx = existing.indexOf(CARD_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const updated = existing.slice(0, startIdx) + cardHtml + existing.slice(endIdx + CARD_END.length);
      writeFileSync(indexPath, updated);
      return;
    }
    console.warn("[toplist] index.html exists but has no toplist-card markers -- leaving it untouched and skipping the card update. Delete it (or add the markers yourself) to let this script manage it.");
    return;
  }

  // Fresh dashboard shell -- future static reports (IDS, universe, ...) can append their own
  // `<!-- <name>-card:start/end -->` block here and this script will only ever touch its own.
  const shell = `<!DOCTYPE html>
<html lang="th">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>akeguru — Reports</title>
<style>body{margin:0;background:#F6F7F5;font-family:-apple-system,'Segoe UI',sans-serif;padding:24px}
.wrap{max-width:1000px;margin:0 auto} h1{font-size:22px;color:#182230} .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-top:16px}</style>
</head>
<body><div class="wrap">
  <h1>akeguru — Reports</h1>
  <div class="grid">
${cardHtml}
  </div>
</div></body>
</html>
`;
  writeFileSync(indexPath, shell);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  let rows: ToplistRow[];
  let isSample: boolean;
  try {
    rows = await queryRealRows();
    isSample = rows.length === 0;
    if (isSample) console.log("[toplist] no scored stocks found in the DB yet -- writing sample data so the report is viewable today. Run `npm run refresh` for real results.");
  } catch (err) {
    console.warn("[toplist] couldn't reach the database -- writing sample data instead so the report is still viewable. Error:", err instanceof Error ? err.message : err);
    rows = [];
    isSample = true;
  }
  if (isSample) rows = SAMPLE_ROWS;

  const generatedAt = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  writeFileSync(path.join(OUT_DIR, "toplist.html"), renderToplistHtml(rows, isSample, generatedAt));
  writeIndexHtml(renderCardHtml(rows, isSample, generatedAt));

  console.log(`[toplist] wrote ${rows.length} row(s) ${isSample ? "(sample data)" : "(real data)"} to ${path.join(OUT_DIR, "toplist.html")}`);
  console.log(`[toplist] updated ${path.join(OUT_DIR, "index.html")}`);
}

main().catch((err) => {
  console.error("[toplist] fatal error:", err);
  process.exitCode = 1;
});
