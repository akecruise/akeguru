/**
 * One-time backfill for FinancialFact.statement/sourceDefinition/splitAdjusted on rows that
 * predate the schema upgrade adding those columns (2026-08-23). New ingests already populate them
 * correctly going forward (see lib/data/input-sources/router.ts, scripts/ingest.ts) -- this is only
 * for rows already in the DB.
 *
 * Yahoo-sourced rows don't need this: RawSource for YAHOO is deduped by content hash, and Yahoo's
 * live-quote data changes basically every day, so the next `npm run refresh`/ingest naturally
 * writes fresh rows with the new fields populated (skipDuplicates never matches a live quote
 * against yesterday's). SEC-sourced rows are the opposite problem: XBRL company facts barely
 * change between quarters, so the same RawSource content hash gets reused for a long time, and
 * skipDuplicates keeps blocking a fresh insert that would've had the new fields -- confirmed live,
 * re-ingesting MSFT wrote 56/122 rows and every one of the pre-existing SEC_MAP rows stayed null.
 *
 * Every SEC_MAP row selectAnnual() (sec.ts) ever wrote is a 10-K annual figure -- that filter is
 * unconditional, so "us-gaap:<tag> (10-K)" is safe to backfill without knowing the original `form`
 * (which wasn't persisted before this schema upgrade either).
 *
 *   npx tsx scripts/backfill-fact-metadata.ts        (updates)
 *   npx tsx scripts/backfill-fact-metadata.ts --dry  (count only, no writes)
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { STATEMENT_BY_TAG, SPLIT_ADJUSTED_BY_TAG } from "../lib/data/input-sources/sec";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const dry = process.argv.includes("--dry");

  const rows = await prisma.financialFact.findMany({
    where: { extractedBy: "SEC_MAP", sourceDefinition: null },
    select: { id: true, metricName: true },
  });

  console.log(`${rows.length} SEC_MAP row(s) missing sourceDefinition${dry ? " (dry run, no writes)" : ""}`);

  let updated = 0;
  for (const row of rows) {
    const tag = row.metricName as keyof typeof STATEMENT_BY_TAG;
    const statement = STATEMENT_BY_TAG[tag] ?? null;
    const splitAdjusted = tag in SPLIT_ADJUSTED_BY_TAG ? SPLIT_ADJUSTED_BY_TAG[tag]! : null;
    const sourceDefinition = `us-gaap:${row.metricName} (10-K)`;

    if (!dry) {
      await prisma.financialFact.update({
        where: { id: row.id },
        data: { statement, sourceDefinition, splitAdjusted },
      });
    }
    updated++;
  }

  console.log(`${dry ? "would update" : "updated"} ${updated} row(s)`);
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
