/**
 * Home page "Market Context" strip -- fetches a small, fixed set of real index/commodity/FX
 * quotes and upserts them into MarketQuote. Standalone from scripts/refresh-universe.ts (that job
 * is per-stock; this is 6 index-level symbols, a different shape) -- run it separately, or chain
 * it after the nightly refresh the same way `npm run toplist` gets chained (see README).
 *
 *   npx tsx scripts/fetch-market-context.ts
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { yahooFinance } from "../lib/yahoo";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL_UNPOOLED });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const SYMBOLS: { symbol: string; label: string }[] = [
  { symbol: "ES=F", label: "S&P Futures" },
  { symbol: "NQ=F", label: "Nasdaq Fut" },
  { symbol: "^SET.BK", label: "SET Index" },
  { symbol: "^HSI", label: "HSI" },
  { symbol: "GC=F", label: "Gold" },
  { symbol: "THB=X", label: "USD/THB" },
];

async function main() {
  let ok = 0;
  let failed = 0;
  for (const { symbol, label } of SYMBOLS) {
    try {
      const q = await yahooFinance.quote(symbol);
      if (q.regularMarketPrice == null) throw new Error("no regularMarketPrice in response");
      await prisma.marketQuote.upsert({
        where: { symbol },
        create: { symbol, label, price: q.regularMarketPrice, changePct: q.regularMarketChangePercent ?? 0 },
        update: { label, price: q.regularMarketPrice, changePct: q.regularMarketChangePercent ?? 0, fetchedAt: new Date() },
      });
      console.log(`${symbol.padEnd(10)} ${label.padEnd(14)} ${q.regularMarketPrice}  ${(q.regularMarketChangePercent ?? 0).toFixed(2)}%`);
      ok++;
    } catch (e) {
      console.warn(`${symbol}: failed -- ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  }
  console.log(`\ndone: ${ok} ok, ${failed} failed`);
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
