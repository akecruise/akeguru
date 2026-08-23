/**
 * Smoke test for lib/report/estimates.ts's buildConsensusEstimates() — pure function, no LLM, no
 * grounding check needed (see that file's header comment for why this section isn't an agent).
 *
 *   npx tsx scripts/test-estimates.ts MSFT
 *
 * Requires scripts/ingest.ts <TICKER> to have been run AFTER the mapYahooEarningsTrendFacts
 * change — re-run ingest first if this prints 0 blocks for a ticker that should have consensus
 * data (Yahoo covers most liquid large-caps; thin-coverage tickers like 1773.HK may genuinely have
 * none).
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { buildConsensusEstimates } from "../lib/report/estimates";
import { validateSection } from "../lib/report/schema";

async function main() {
  const ticker = process.argv[2] ?? "MSFT";
  const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const facts = await prisma.financialFact.findMany({
    where: { ticker, metricName: { startsWith: "Revenue Estimate" } },
    select: { metricName: true, value: true, period: true },
  });
  const facts2 = await prisma.financialFact.findMany({
    where: { ticker, metricName: { startsWith: "EPS Estimate" } },
    select: { metricName: true, value: true, period: true },
  });
  const allFacts = [...facts, ...facts2];

  console.log(`${ticker}: ${allFacts.length} consensus fact(s) found in FinancialFact`);

  const blocks = buildConsensusEstimates(allFacts);
  console.log(`\n${blocks.length} EstimateBlock(s): ${blocks.map((b) => b.metric).join(", ") || "(none)"}`);

  const result = validateSection("estimates", blocks);
  console.log(`\nzod validation: ${result.ok ? "PASS ✓" : "FAIL ✗"}`);
  if (!result.ok) {
    console.log("errors:", result.errors);
    process.exitCode = 1;
  }

  console.log("\nfull EstimateBlock[] JSON:");
  console.log(JSON.stringify(blocks, null, 2));

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
