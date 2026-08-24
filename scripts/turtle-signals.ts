/**
 * Turtle Trading signals (lib/turtle.ts) for one or every tracked ticker -- Donchian breakout
 * status (System 1 short-term, System 2 long-term, and whether both confirm the same direction)
 * plus the ATR-derived ("N") suggested entry weight. Read-only, same "check the signal, don't act
 * on it automatically" posture as scripts/scorecard.ts.
 *
 *   npx tsx scripts/turtle-signals.ts             (every active stock with enough price history)
 *   npx tsx scripts/turtle-signals.ts MSFT        (one ticker)
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { computeTurtleSignal, computeATR, suggestTurtleWeight, ATR_WEEKS, type WeeklyBar } from "../lib/turtle";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const tickerFilter = process.argv[2];

  const stocks = await prisma.stock.findMany({
    where: { isActive: true, ...(tickerFilter ? { ticker: tickerFilter } : {}) },
    select: { id: true, ticker: true, price: true },
  });

  if (!stocks.length) {
    console.log(tickerFilter ? `no active stock ${tickerFilter}` : "no active stocks");
    return;
  }

  console.log("| ticker | bars | S1 (4w/2w) | S2 (11w/4w) | confirmed | N | suggested weight |");
  console.log("|---|---|---|---|---|---|---|");

  let skippedForData = 0;
  for (const stock of stocks) {
    const rows = await prisma.priceHistory.findMany({
      where: { stockId: stock.id, high: { not: null }, low: { not: null } },
      orderBy: { date: "asc" },
      select: { high: true, low: true, close: true },
    });
    const bars: WeeklyBar[] = rows.map((r) => ({ high: r.high!, low: r.low!, close: r.close }));

    if (bars.length < 12) {
      skippedForData++;
      if (tickerFilter) console.log(`${stock.ticker}: only ${bars.length} bar(s) with high/low -- not enough for even System 1`);
      continue;
    }

    const signal = computeTurtleSignal(bars);
    const n = computeATR(bars, ATR_WEEKS);
    const sized = stock.price != null ? suggestTurtleWeight(stock.price, n) : null;

    const s1 = signal.system1 ? (signal.system1.breakoutLong ? "LONG" : signal.system1.breakoutShort ? "SHORT" : "-") : "n/a";
    const s2 = signal.system2 ? (signal.system2.breakoutLong ? "LONG" : signal.system2.breakoutShort ? "SHORT" : "-") : "n/a";
    const confirmed = signal.confirmedLong ? "LONG" : signal.confirmedShort ? "SHORT" : "";

    console.log(
      `| ${stock.ticker} | ${bars.length} | ${s1} | ${s2} | ${confirmed} | ${n != null ? n.toFixed(2) : "—"} | ${sized ? sized.suggestedWeightPct.toFixed(1) + "%" : "—"} |`,
    );
  }

  if (skippedForData > 0 && !tickerFilter) {
    console.log(`\n${skippedForData} stock(s) skipped -- not enough price history with high/low yet (run scripts/backfill-price-ohlc.ts)`);
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
