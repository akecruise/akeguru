/**
 * One-time backfill for PriceHistory.high/low on rows written before that schema upgrade
 * (2026-08-24, for Turtle Trading's Donchian channels + ATR/"N", lib/turtle.ts). New rows already
 * get high/low going forward (lib/refresh.ts) -- this is only for rows already in the DB.
 *
 * Doesn't rely on lib/refresh.ts's normal backfill path: that one is guarded by
 * `existingPriceRows < 8`, so any stock that already has a full weekly history (nearly all of
 * them, ~65 rows each) never re-runs it and would stay missing high/low forever. This script
 * re-fetches weekly OHLC unconditionally for every active stock and updates matching PriceHistory
 * rows by date, regardless of how many rows already exist.
 *
 * Uses raw `pg` instead of PrismaClient for the DB reads/writes -- confirmed live that
 * PrismaClient (via the `@prisma/adapter-pg` driver adapter against the local `prisma dev` server)
 * intermittently throws "bind message supplies N parameters, but prepared statement requires 0"
 * partway through a long run of sequential queries, while a plain `pg` client against the exact
 * same server never did across the same load. Whatever's unstable is specific to that Prisma
 * Client/adapter/local-dev-server combination under sustained sequential query volume, not the data
 * or the server itself -- raw `pg` sidesteps it for this one-time bulk script rather than fighting it.
 *
 *   npx tsx scripts/backfill-price-ohlc.ts        (updates)
 *   npx tsx scripts/backfill-price-ohlc.ts --dry  (count only, no writes)
 */
import "dotenv/config";
import pg from "pg";
import { fetchWeeklyPriceHistory } from "../lib/yahoo";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });

async function main() {
  const dry = process.argv.includes("--dry");

  const { rows: stocks } = await pool.query<{ id: string; ticker: string }>(
    'SELECT id, ticker FROM "Stock" WHERE "isActive" = true',
  );
  console.log(`${stocks.length} active stock(s) to backfill${dry ? " (dry run, no writes)" : ""}`);

  let updated = 0;
  let failed = 0;
  for (const stock of stocks) {
    try {
      const history = await fetchWeeklyPriceHistory(stock.ticker);
      for (const point of history) {
        if (point.high == null && point.low == null) continue; // nothing to backfill for this row
        const date = new Date(Date.UTC(point.date.getUTCFullYear(), point.date.getUTCMonth(), point.date.getUTCDate()));
        if (!dry) {
          await pool.query(
            'UPDATE "PriceHistory" SET high = $1, low = $2 WHERE "stockId" = $3 AND date = $4',
            [point.high, point.low, stock.id, date],
          );
        }
        updated++;
      }
    } catch (err) {
      failed++;
      console.warn(`  ${stock.ticker}: failed -- ${(err as Error).message}`);
    }
  }

  console.log(`\n${updated} row(s) ${dry ? "would be " : ""}updated, ${failed} ticker(s) failed`);
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exitCode = 1;
  });
