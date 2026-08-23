/**
 * Manually add a CompanyRelation row (Phase 2 roadmap item) -- see prisma/schema.prisma's
 * CompanyRelation doc comment for why this is manual (no inference agent exists yet) and what the
 * direction means.
 *
 *   npx tsx scripts/add-company-relation.ts <TICKER> <SUPPLIER|CUSTOMER|COMPETITOR|BENEFICIARY> <RELATED_TICKER> ["notes"]
 *   npx tsx scripts/add-company-relation.ts NVDA BENEFICIARY MSFT "Azure/OpenAI GPU capex buildout"
 *
 *   npx tsx scripts/add-company-relation.ts --list <TICKER>   (both directions)
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const RELATION_TYPES = ["SUPPLIER", "CUSTOMER", "COMPETITOR", "BENEFICIARY"] as const;

async function list(ticker: string) {
  const outgoing = await prisma.companyRelation.findMany({ where: { ticker } });
  const incoming = await prisma.companyRelation.findMany({ where: { relatedTicker: ticker } });

  console.log(`${ticker} ->`);
  for (const r of outgoing) console.log(`  ${r.relationType} ${r.relatedTicker}${r.notes ? ` — ${r.notes}` : ""}`);
  console.log(`-> ${ticker}`);
  for (const r of incoming) console.log(`  ${r.ticker} is a ${r.relationType} of ${ticker}${r.notes ? ` — ${r.notes}` : ""}`);
  if (!outgoing.length && !incoming.length) console.log("  (no relations recorded)");
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--list") {
    await list(args[1]);
    return;
  }

  const [ticker, relationTypeRaw, relatedTicker, notes] = args;
  const relationType = relationTypeRaw?.toUpperCase();
  if (!ticker || !relatedTicker || !RELATION_TYPES.includes(relationType as (typeof RELATION_TYPES)[number])) {
    console.log(`usage: npx tsx scripts/add-company-relation.ts <TICKER> <${RELATION_TYPES.join("|")}> <RELATED_TICKER> ["notes"]`);
    console.log(`       npx tsx scripts/add-company-relation.ts --list <TICKER>`);
    process.exitCode = 1;
    return;
  }

  const row = await prisma.companyRelation.upsert({
    where: { ticker_relatedTicker_relationType: { ticker, relatedTicker, relationType: relationType as (typeof RELATION_TYPES)[number] } },
    create: { ticker, relatedTicker, relationType: relationType as (typeof RELATION_TYPES)[number], notes: notes ?? null },
    update: { notes: notes ?? null },
  });
  console.log(`saved: ${row.ticker} -[${row.relationType}]-> ${row.relatedTicker}${row.notes ? ` (${row.notes})` : ""}`);
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
