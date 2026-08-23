/**
 * Position Sizing Model (Phase 5 roadmap item) -- for every ticker whose *latest* ResearchReport is
 * a GO (an old, superseded GO doesn't get sized -- only the current verdict matters), computes
 * realized annualized volatility from the last ~52 weeks of real PriceHistory (which is stored
 * weekly, not daily -- see lib/position-sizing.ts's computeAnnualizedVolatility doc comment)
 * and suggests a position size (% of capital) via inverse-volatility sizing scaled by conviction
 * (suggestPositionSize).
 *
 * Not a portfolio optimizer and doesn't know about existing holdings -- see README's Position Sizing
 * Model section for why (no Position/Portfolio $ tracking exists in this app yet, and building one
 * wasn't asked for). Each row is an independent suggestion; a human still owns the actual allocation
 * decision, especially the "do these overlap too much" question (see scripts/portfolio-factor-overlap.ts).
 *
 *   npx tsx scripts/position-sizing.ts             (every ticker whose latest verdict is GO)
 *   npx tsx scripts/position-sizing.ts MSFT        (one ticker)
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { computeAnnualizedVolatility, suggestPositionSize, MIN_WEEKS_FOR_VOL } from "../lib/position-sizing";

const TRAILING_WEEKS = 52;

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const tickerFilter = process.argv[2];

  // Latest ResearchReport per ticker, DISTINCT ON-style via orderBy + a Map that keeps only the
  // first (most recent) row seen per ticker -- same "closest/most-recent row" pattern scorecard.ts
  // and thesis-momentum.ts already use, just picking one row per ticker instead of the whole history.
  // dataAsOf is a *date*, not a timestamp -- same-day reruns (common while iterating on this
  // pipeline) tie on it, so createdAt breaks the tie in favor of the actually-most-recent run.
  // Caught live: without this, a same-day MSFT rerun could pick an older, already-superseded row.
  const reports = await prisma.researchReport.findMany({
    where: tickerFilter ? { ticker: tickerFilter } : undefined,
    orderBy: [{ ticker: "asc" }, { dataAsOf: "desc" }, { createdAt: "desc" }],
    select: { ticker: true, dataAsOf: true, decision: true, conviction: true },
  });

  if (!reports.length) {
    console.log(tickerFilter ? `no ResearchReport for ${tickerFilter}` : "no ResearchReport rows at all -- run scripts/run-report.ts first");
    return;
  }

  const latestByTicker = new Map<string, (typeof reports)[number]>();
  for (const r of reports) {
    if (!latestByTicker.has(r.ticker)) latestByTicker.set(r.ticker, r); // first row per ticker = most recent, given the orderBy above
  }

  console.log("| ticker | decision | conv | annualized vol | suggested weight | notes |");
  console.log("|---|---|---|---|---|---|");

  let anySized = false;
  for (const [ticker, r] of latestByTicker) {
    if (r.decision !== "GO") {
      if (tickerFilter) console.log(`| ${ticker} | ${r.decision} | ${r.conviction} | — | — | not a current GO -- not sized |`);
      continue;
    }

    const stock = await prisma.stock.findUnique({ where: { ticker }, select: { id: true } });
    const priceRows = stock
      ? await prisma.priceHistory.findMany({
          where: { stockId: stock.id },
          orderBy: { date: "desc" },
          take: TRAILING_WEEKS,
          select: { close: true },
        })
      : [];
    const closes = priceRows.map((p) => p.close).reverse(); // desc -> ascending (oldest first), what computeAnnualizedVolatility expects

    const annualizedVol = computeAnnualizedVolatility(closes);
    const sized = suggestPositionSize(r.conviction, annualizedVol);

    anySized = true;
    const volCell = annualizedVol === null ? "—" : `${(annualizedVol * 100).toFixed(1)}%`;
    const sizeCell = sized === null ? "—" : `${sized.suggestedWeightPct.toFixed(1)}%`;
    const notes = sized === null ? (annualizedVol === null ? `< ${MIN_WEEKS_FOR_VOL} weeks of price history` : "conviction below GO floor (3) -- flag, don't size") : "";
    console.log(`| ${ticker} | ${r.decision} | ${r.conviction} | ${volCell} | ${sizeCell} | ${notes} |`);
  }

  if (!anySized) {
    console.log(tickerFilter ? `${tickerFilter}'s latest verdict isn't GO -- nothing to size` : "no ticker's latest verdict is currently GO -- nothing to size");
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
