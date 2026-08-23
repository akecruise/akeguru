/**
 * Layer 3 smoke test — runs the business agent for a real ticker against real FinancialFact rows
 * already in the DB (run scripts/ingest.ts <TICKER> first).
 *
 *   npx tsx scripts/test-business-agent.ts MSFT
 *
 * Unlike valuation/risk/moat, this agent also needs to know what the company actually does —
 * FinancialFact has no such field, so this script fetches Stock.description/sector/industry (the
 * old MVP's cached Yahoo longBusinessSummary — see prisma/schema.prisma's Stock model) and passes
 * it as extraContext. Not every ticker has a Stock row (e.g. 1773.HK, which was never in the
 * curated universe) — business.md's rule #3 requires an explicit "no description available"
 * fallback rather than guessing, so this script exercises both paths.
 *
 * Calls whichever backend AGENT_PROVIDER resolves to (see lib/agents/runner.ts).
 *
 * Pass criteria:
 *   1. output passes zod (validateSection inside runAgent already enforces this — every
 *      ClaimItem has supportingFactIds with >=1 entry)
 *   2-3. lib/agents/grounding.ts's checkClaimGrounding(): every supportingFactIds entry exists
 *        in FinancialFact, and every financial-looking number in claim is within ±5% of some fact
 *        among that item's supportingFactIds
 *
 * Things the code can't check, printed in full below for manual read-through instead:
 *   - product/segment claims are actually traceable to the given [companyProfile] text, not
 *     invented from the model's own training-data memory of the ticker (rule #3)
 *   - the no-description fallback path is honest (states the gap) rather than guessing anyway
 */
import "dotenv/config";
import path from "path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { runAgent } from "../lib/agents/runner";
import { checkClaimGrounding, type RealFact } from "../lib/agents/grounding";
import { buildCompanyProfileContext } from "../lib/agents/context";
import type { ClaimItem } from "../lib/report/types";

const AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/business.md");

async function main() {
  const ticker = process.argv[2] ?? "MSFT";
  const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const companyProfileContext = await buildCompanyProfileContext(prisma, ticker);
  console.log(`companyProfile context for ${ticker}:\n${companyProfileContext.slice(0, 200)}${companyProfileContext.length > 200 ? "..." : ""}\n`);

  console.log(`running business agent for ${ticker}...`);
  const result = await runAgent(prisma, ticker, AGENT_PATH, "businessSummary", undefined, companyProfileContext);

  console.log(`\nok=${result.ok} retryCount=${result.retryCount} modelTier=${result.modelTier} provider=${result.provider}/${result.backendModel} elapsedMs=${result.elapsedMs}`);
  if (!result.ok) {
    console.log("errors:", result.errors);
    process.exitCode = 1;
    await prisma.$disconnect();
    await pool.end();
    return;
  }
  console.log("1. zod validation: PASS ✓ (enforced inside runAgent before save)");

  const businessSummary = result.content as ClaimItem[];
  console.log(`\n${businessSummary.length} paragraph(s)`);

  const factIds = [...new Set(businessSummary.flatMap((c) => c.supportingFactIds))];
  const realFacts: RealFact[] = factIds.length
    ? await prisma.financialFact.findMany({
        where: { id: { in: factIds } },
        select: { id: true, metricName: true, value: true, unit: true },
      })
    : [];

  const grounding = checkClaimGrounding(businessSummary, realFacts);
  console.log(`\n2-3. claim grounding check (exhaustive over all ${grounding.checkedCount} paragraph(s)):`);
  if (grounding.ok) {
    console.log("   PASS ✓ — every supportingFactIds entry exists, every financial-looking number is within ±5% of a cited fact");
  } else {
    console.log(`   FAIL ✗ — ${grounding.issues.length} issue(s):`);
    for (const issue of grounding.issues) console.log(`   - [${issue.reason}] ${issue.title}: ${issue.detail}`);
    process.exitCode = 1;
  }

  console.log("\nfull businessSummary JSON (check: product/segment claims trace to [companyProfile] above, not the model's own memory of the ticker):");
  console.log(JSON.stringify(businessSummary, null, 2));

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
