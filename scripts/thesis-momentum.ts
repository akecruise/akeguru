/**
 * Thesis Momentum Score (Phase 4 roadmap item, "from diff history") — for each ticker with >= 2
 * ResearchReport rows, diffs decision/conviction between the earliest and latest report
 * (lib/thesis-momentum.ts) and prints the trend.
 *
 * Honest limitation, not hidden: today, every ticker's report history is same-day reruns (this
 * pipeline is brand new), so any "trend" shown right now reflects LLM run-to-run variance on
 * mostly-unchanged fundamentals, not real thesis evolution over calendar time. The mechanism is
 * verified live against that real (if same-day) history; a genuinely meaningful signal needs
 * reports actually spaced weeks/months apart with real underlying data changes, which doesn't
 * exist yet. Safe to re-run any time as real history accumulates -- nothing here needs updating.
 *
 *   npx tsx scripts/thesis-momentum.ts             (every ticker with >= 2 reports)
 *   npx tsx scripts/thesis-momentum.ts MSFT         (one ticker)
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { computeThesisMomentum, type ThesisSnapshot } from "../lib/thesis-momentum";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const tickerFilter = process.argv[2];
  const reports = await prisma.researchReport.findMany({
    where: tickerFilter ? { ticker: tickerFilter } : undefined,
    orderBy: [{ ticker: "asc" }, { dataAsOf: "asc" }, { createdAt: "asc" }],
    select: { ticker: true, dataAsOf: true, createdAt: true, decision: true, conviction: true },
  });

  if (!reports.length) {
    console.log(tickerFilter ? `no ResearchReport for ${tickerFilter}` : "no ResearchReport rows at all — run scripts/run-report.ts first");
    return;
  }

  const byTicker = new Map<string, ThesisSnapshot[]>();
  for (const r of reports) {
    const list = byTicker.get(r.ticker) ?? [];
    list.push({ dataAsOf: r.dataAsOf, createdAt: r.createdAt, decision: r.decision, conviction: r.conviction });
    byTicker.set(r.ticker, list);
  }

  console.log("| ticker | reports | first | last | decision trend | conviction trend | momentum |");
  console.log("|---|---|---|---|---|---|---|");

  let anyShown = false;
  for (const [ticker, history] of byTicker) {
    const result = computeThesisMomentum(history);
    if (!result) continue; // < 2 reports -- nothing to diff
    anyShown = true;
    const arrow = result.momentumScore > 0.1 ? "📈" : result.momentumScore < -0.1 ? "📉" : "➡️";
    console.log(
      `| ${ticker} | ${result.snapshotCount} | ${result.first.decision} (conv ${result.first.conviction}) | ${result.last.decision} (conv ${result.last.conviction}) | ${result.decisionTrend} | ${result.convictionTrend} | ${arrow} ${result.momentumScore.toFixed(2)} |`,
    );
  }

  if (!anyShown) {
    console.log(tickerFilter ? `${tickerFilter} has only 1 report -- need >= 2 to compute a trend` : "no ticker has >= 2 reports yet -- need repeat runs over time to compute a trend");
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
