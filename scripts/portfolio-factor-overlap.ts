/**
 * Portfolio Factor Overlap (Phase 5 roadmap item) -- for a user's WatchlistItem tickers (the
 * portfolio proxy, see lib/portfolio-factor-overlap.ts's doc comment for why), pulls each ticker's
 * latest ResearchReport.payload.factorSensitivity (Phase 2's Factor Sensitivity Agent output) and
 * flags any macro factor at least OVERLAP_MIN_COUNT tickers share a 'high'-weight exposure to in the
 * same direction -- a concentration risk a human reviewing tickers one at a time wouldn't easily spot.
 *
 *   npx tsx scripts/portfolio-factor-overlap.ts <email>
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import type { StockReport } from "../lib/report/types";
import { computeFactorOverlap, type TickerFactorExposure } from "../lib/portfolio-factor-overlap";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.log("usage: npx tsx scripts/portfolio-factor-overlap.ts <email>");
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { watchlistItems: { select: { stock: { select: { ticker: true } } } } },
  });
  if (!user) {
    console.log(`no User with email ${email}`);
    process.exitCode = 1;
    return;
  }
  const tickers = user.watchlistItems.map((w) => w.stock.ticker);
  if (!tickers.length) {
    console.log(`${email} has no watchlist items -- nothing to check`);
    return;
  }

  const tickerExposures: TickerFactorExposure[] = [];
  const skipped: string[] = [];
  for (const ticker of tickers) {
    // dataAsOf is a date, not a timestamp -- createdAt breaks same-day-rerun ties in favor of the
    // actually-most-recent run (see scripts/position-sizing.ts's doc comment for the live bug this
    // caught: a naive dataAsOf-only sort can resolve a same-day tie to a superseded row).
    const report = await prisma.researchReport.findFirst({
      where: { ticker },
      orderBy: [{ dataAsOf: "desc" }, { createdAt: "desc" }],
      select: { payload: true },
    });
    if (!report) {
      skipped.push(`${ticker} (no ResearchReport yet)`);
      continue;
    }
    const exposures = (report.payload as unknown as StockReport).factorSensitivity ?? [];
    tickerExposures.push({ ticker, exposures });
  }

  console.log(`${email}: ${tickers.length} watchlist ticker(s), ${tickerExposures.length} with a ResearchReport`);
  if (skipped.length) console.log(`skipped (no report yet): ${skipped.join(", ")}`);

  const overlap = computeFactorOverlap(tickerExposures);
  if (!overlap.length) {
    console.log("\nno shared high-weight macro factor across enough tickers to flag -- no concentration signal");
    return;
  }

  console.log("\n| factor | direction | tickers sharing it | count |");
  console.log("|---|---|---|---|");
  for (const row of overlap) {
    console.log(`| ${row.factor} | ${row.direction} | ${row.tickers.join(", ")} | ${row.count} |`);
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
