/**
 * CCASS shareholding concentration -- real ownership data scraped from hkexnews.hk (who holds
 * the stock, through which broker/participant). NOT short interest -- HKEX/CCASS doesn't
 * publish short positions; that's a separate SFC disclosure regime this script doesn't cover.
 *
 *   npx tsx scripts/fetch-ccass.ts 1773.HK
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../generated/prisma/client";
import { fetchCcassSnapshot, computeConcentration } from "../lib/data/input-sources/ccass";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL_UNPOOLED });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const ticker = process.argv[2];
  if (!ticker) {
    console.error("usage: npx tsx scripts/fetch-ccass.ts <TICKER>");
    process.exitCode = 1;
    return;
  }

  console.log(`fetching CCASS shareholding for ${ticker}...`);
  const snap = await fetchCcassSnapshot(ticker);
  const conc = computeConcentration(snap.holders);

  console.log(`\nas of ${snap.asOfDate}`);
  console.log(`participants: ${snap.totalParticipants}`);
  console.log(`% of issued shares held in CCASS: ${snap.totalPctOfIssued}%`);
  console.log(`top 1 holder: ${conc.topHolders[0]?.name ?? "—"} (${conc.top1PctOfIssued ?? "—"}%)`);
  console.log(`top 10 concentration: ${conc.top10PctOfIssued?.toFixed(2) ?? "—"}%`);
  console.log("\ntop holders:");
  for (const h of conc.topHolders) {
    console.log(`  ${h.participantId}  ${h.name.padEnd(40)} ${h.shareholding.toLocaleString().padStart(15)}  ${h.pctOfIssued.toFixed(2)}%`);
  }

  const [y, m, d] = snap.asOfDate.split("/").map(Number);
  const asOfDate = new Date(Date.UTC(y, m - 1, d));

  await prisma.ccassSnapshot.upsert({
    where: { ticker_asOfDate: { ticker, asOfDate } },
    create: {
      ticker,
      asOfDate,
      totalShareholding: snap.totalShareholding,
      totalParticipants: snap.totalParticipants,
      totalPctOfIssued: snap.totalPctOfIssued,
      totalIssuedShares: snap.totalIssuedShares,
      top1PctOfIssued: conc.top1PctOfIssued,
      top10PctOfIssued: conc.top10PctOfIssued,
      topHolders: conc.topHolders as unknown as Prisma.InputJsonValue,
    },
    update: {
      totalShareholding: snap.totalShareholding,
      totalParticipants: snap.totalParticipants,
      totalPctOfIssued: snap.totalPctOfIssued,
      totalIssuedShares: snap.totalIssuedShares,
      top1PctOfIssued: conc.top1PctOfIssued,
      top10PctOfIssued: conc.top10PctOfIssued,
      topHolders: conc.topHolders as unknown as Prisma.InputJsonValue,
      fetchedAt: new Date(),
    },
  });
  console.log(`\nsaved CcassSnapshot for ${ticker} @ ${snap.asOfDate}`);
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
