/**
 * Verdict Scorecard — logs every ResearchReport's verdict against what the price actually did
 * afterward, and flags "regret" on WAIT calls specifically: a WAIT is a bet that there's no rush,
 * so a big run-up since the verdict without anyone re-reviewing it is exactly the failure mode
 * worth surfacing (GO/NO_GO get the same price-return columns for context, but regret is only
 * defined for WAIT — a GO that ran up is a win, not a regret, and there's no "should have bought"
 * framing for a NO_GO).
 *
 * On-demand, not a persisted snapshot — every input (ResearchReport, PriceHistory) already exists
 * and is cheap to join at read time (a few hundred reports, a few thousand price rows), so there's
 * nothing to gain from storing a redundant copy that could drift out of sync with the real prices.
 * Re-run any time to get today's numbers; no Task Scheduler entry needed (see the point above).
 *
 *   npx tsx scripts/scorecard.ts             (every ResearchReport)
 *   npx tsx scripts/scorecard.ts MSFT        (one ticker's history)
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import type { StockReport, InvalidationTrigger, TriggerComparator } from "../lib/report/types";

const REGRET_THRESHOLD_PCT = 15; // a WAIT that ran up 15%+ with no re-review is worth a second look

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

interface Row {
  ticker: string;
  decision: string;
  conviction: number;
  dataAsOf: Date;
  reviewDate: string;
  gateStatus: string;
  priceAtVerdict: number | null;
  currentPrice: number | null;
  returnPct: number | null;
  daysSince: number;
  pastReviewDate: boolean;
  regret: boolean;
  triggersTotal: number;
  firedTriggers: Array<InvalidationTrigger & { currentValue: number }>;
}

function comparatorFires(comparator: TriggerComparator, value: number, threshold: number): boolean {
  switch (comparator) {
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
  }
}

/** Latest FinancialFact.value for this exact (ticker, metricName) — mirrors how gate2Consistency's
 *  checkInvalidationTriggers verified the metricName exists at report-time; this is the same lookup
 *  but for "what's it actually reading right now", not "does it exist at all". */
async function latestFactValue(ticker: string, metricName: string): Promise<number | null> {
  const row = await prisma.financialFact.findFirst({
    where: { ticker, metricName },
    orderBy: { extractedAt: "desc" },
    select: { value: true },
  });
  return row?.value ?? null;
}

/** Latest PriceHistory close on or before `date` — PriceHistory is only ever written for trading
 *  days the refresh job actually ran on, so an exact match on `dataAsOf` isn't guaranteed
 *  (weekends, a missed refresh day). Nearest prior close is the honest "price at the time" either
 *  way; there's no real price on a day the market didn't trade. */
async function priceOnOrBefore(stockId: string, date: Date): Promise<number | null> {
  const row = await prisma.priceHistory.findFirst({
    where: { stockId, date: { lte: date } },
    orderBy: { date: "desc" },
    select: { close: true },
  });
  return row?.close ?? null;
}

async function latestPrice(stockId: string): Promise<number | null> {
  const row = await prisma.priceHistory.findFirst({ where: { stockId }, orderBy: { date: "desc" }, select: { close: true } });
  return row?.close ?? null;
}

async function main() {
  const tickerFilter = process.argv[2];
  const reports = await prisma.researchReport.findMany({
    where: tickerFilter ? { ticker: tickerFilter } : undefined,
    orderBy: [{ ticker: "asc" }, { dataAsOf: "asc" }],
  });

  if (!reports.length) {
    console.log(tickerFilter ? `no ResearchReport for ${tickerFilter}` : "no ResearchReport rows at all — run scripts/run-report.ts first");
    return;
  }

  const stockIdCache = new Map<string, string | null>();
  async function stockId(ticker: string): Promise<string | null> {
    if (!stockIdCache.has(ticker)) {
      const s = await prisma.stock.findUnique({ where: { ticker }, select: { id: true } });
      stockIdCache.set(ticker, s?.id ?? null);
    }
    return stockIdCache.get(ticker)!;
  }

  const now = new Date();
  const rows: Row[] = [];

  for (const r of reports) {
    const sid = await stockId(r.ticker);
    const priceAtVerdict = sid ? await priceOnOrBefore(sid, r.dataAsOf) : null;
    const currentPrice = sid ? await latestPrice(sid) : null;
    const returnPct = priceAtVerdict && currentPrice ? ((currentPrice - priceAtVerdict) / priceAtVerdict) * 100 : null;
    const daysSince = Math.round((now.getTime() - r.dataAsOf.getTime()) / (24 * 60 * 60 * 1000));
    const verdict = (r.payload as unknown as StockReport).verdict;
    const reviewDate = verdict?.reviewDate ?? "?";
    const pastReviewDate = reviewDate !== "?" && now >= new Date(`${reviewDate}T00:00:00Z`);
    const regret = r.decision === "WAIT" && returnPct !== null && returnPct >= REGRET_THRESHOLD_PCT;

    const triggers = verdict?.invalidationTriggers ?? [];
    const firedTriggers: Row["firedTriggers"] = [];
    for (const t of triggers) {
      const currentValue = await latestFactValue(r.ticker, t.metricName);
      if (currentValue !== null && comparatorFires(t.comparator, currentValue, t.threshold)) {
        firedTriggers.push({ ...t, currentValue });
      }
    }

    rows.push({
      ticker: r.ticker,
      decision: r.decision,
      conviction: r.conviction,
      dataAsOf: r.dataAsOf,
      reviewDate,
      gateStatus: r.gateStatus,
      priceAtVerdict,
      currentPrice,
      returnPct,
      triggersTotal: triggers.length,
      firedTriggers,
      daysSince,
      pastReviewDate,
      regret,
    });
  }

  const fmtPrice = (v: number | null) => (v === null ? "—" : v.toFixed(2));
  const fmtPct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

  console.log(
    "| ticker | decision | conv | dataAsOf | days | price@verdict | current | return | past review | gate | regret | triggers |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    const triggersCell = row.firedTriggers.length ? `🔴 ${row.firedTriggers.length}/${row.triggersTotal} fired` : `${row.triggersTotal}`;
    console.log(
      `| ${row.ticker} | ${row.decision} | ${row.conviction} | ${row.dataAsOf.toISOString().slice(0, 10)} | ${row.daysSince} | ${fmtPrice(row.priceAtVerdict)} | ${fmtPrice(row.currentPrice)} | ${fmtPct(row.returnPct)} | ${row.pastReviewDate ? "⚠ yes" : "no"} | ${row.gateStatus} | ${row.regret ? "🔴 REGRET" : ""} | ${triggersCell} |`,
    );
  }

  const regretRows = rows.filter((r) => r.regret);
  console.log(`\n${regretRows.length} WAIT verdict(s) flagged as regret (>= +${REGRET_THRESHOLD_PCT}% since verdict, no re-review):`);
  for (const r of regretRows) {
    console.log(`  ${r.ticker}: WAIT on ${r.dataAsOf.toISOString().slice(0, 10)} at ${fmtPrice(r.priceAtVerdict)} -> now ${fmtPrice(r.currentPrice)} (${fmtPct(r.returnPct)})`);
  }

  const triggeredRows = rows.filter((r) => r.firedTriggers.length > 0);
  const totalFired = triggeredRows.reduce((sum, r) => sum + r.firedTriggers.length, 0);
  console.log(`\n${totalFired} invalidation trigger(s) fired across ${triggeredRows.length} report(s):`);
  for (const r of triggeredRows) {
    for (const t of r.firedTriggers) {
      console.log(`  ${r.ticker} (${r.decision} on ${r.dataAsOf.toISOString().slice(0, 10)}): ${t.description} — ${t.metricName}=${t.currentValue.toLocaleString()} ${t.comparator} ${t.threshold.toLocaleString()}`);
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    await pool.end();
    process.exitCode = 1;
  });
