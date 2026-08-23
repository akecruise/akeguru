/**
 * Layer 3 smoke test — runs the synthesis ("boss") agent for a real ticker. Every other agent has
 * this single-ticket counterpart to its eval-*.ts sweep script; synthesis never did until now.
 *
 *   npx tsx scripts/test-synthesis-agent.ts MSFT
 *   AGENT_PROVIDER=claude-cli npx tsx scripts/test-synthesis-agent.ts MSFT
 *
 * Needs fundamentals/riskFactors/moat context (see lib/agents/context.ts's
 * getOrGenerateSectionOutput) — reuses a cached AnalysisOutput row for the ticker if one exists,
 * otherwise generates one fresh via gemini specifically (not whatever provider this script itself
 * is testing — that context should stay constant, only the provider under test should vary).
 *
 * Pass criteria:
 *   1. output passes zod (validateSection inside runAgent already enforces this — every bull/bear
 *      ClaimItem has supportingFactIds with >=1 entry, verdict.reviewDate is >=90 days out)
 *   2-3. lib/agents/grounding.ts's checkClaimGrounding() on bulls and bears separately: every
 *        supportingFactIds entry exists in FinancialFact, and every financial-looking number in
 *        `claim` is within ±5% of a cited fact — see scripts/test-grounding.ts cases 14-19.
 *
 * Things the code can't check, printed in full below for manual read-through instead:
 *   - does verdict.thesis actually weigh bulls against bears, or just restate one side
 *   - does the verdict respect what risk.md/moat.md already concluded (rules #3/#4 in synthesis.md)
 */
import "dotenv/config";
import path from "path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { runAgent } from "../lib/agents/runner";
import { checkClaimGrounding, type RealFact } from "../lib/agents/grounding";
import { buildSynthesisContext, getOrGenerateSectionOutput } from "../lib/agents/context";
import type { Synthesis } from "../lib/report/types";

const SYNTHESIS_AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/synthesis.md");
const VALUATION_AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/valuation.md");
const RISK_AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/risk.md");
const MOAT_AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/moat.md");

async function main() {
  const ticker = process.argv[2] ?? "MSFT";
  const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  console.log(`loading fundamentals/riskFactors/moat context for ${ticker}...`);
  const fundamentals = await getOrGenerateSectionOutput(prisma, ticker, "fundamentals", VALUATION_AGENT_PATH);
  const riskFactors = await getOrGenerateSectionOutput(prisma, ticker, "riskFactors", RISK_AGENT_PATH);
  const moat = await getOrGenerateSectionOutput(prisma, ticker, "moat", MOAT_AGENT_PATH);
  const todayIso = new Date().toISOString().slice(0, 10);
  const extraContext = buildSynthesisContext(fundamentals, riskFactors, moat, todayIso);

  console.log(`running synthesis agent for ${ticker}...`);
  const result = await runAgent(prisma, ticker, SYNTHESIS_AGENT_PATH, "synthesis", undefined, extraContext);

  console.log(`\nok=${result.ok} retryCount=${result.retryCount} modelTier=${result.modelTier} provider=${result.provider}/${result.backendModel} elapsedMs=${result.elapsedMs}`);
  if (!result.ok) {
    console.log("errors:", result.errors);
    process.exitCode = 1;
    await prisma.$disconnect();
    await pool.end();
    return;
  }
  console.log("1. zod validation: PASS ✓ (enforced inside runAgent before save)");

  const synthesis = result.content as Synthesis;
  console.log(`\nbulls=${synthesis.bulls.length} bears=${synthesis.bears.length} decision=${synthesis.verdict.decision} conviction=${synthesis.verdict.conviction}`);

  const factIds = [...new Set([...synthesis.bulls, ...synthesis.bears].flatMap((c) => c.supportingFactIds))];
  const realFacts: RealFact[] = factIds.length
    ? await prisma.financialFact.findMany({ where: { id: { in: factIds } }, select: { id: true, metricName: true, value: true, unit: true } })
    : [];

  const bullsGrounding = checkClaimGrounding(synthesis.bulls, realFacts);
  const bearsGrounding = checkClaimGrounding(synthesis.bears, realFacts);
  console.log(`\n2-3. claim grounding check (bulls: ${bullsGrounding.checkedCount}, bears: ${bearsGrounding.checkedCount}):`);
  if (bullsGrounding.ok && bearsGrounding.ok) {
    console.log("   PASS ✓ — every supportingFactIds entry exists, every financial-looking number is within ±5% of a cited fact");
  } else {
    console.log("   FAIL ✗ — issues:");
    for (const issue of bullsGrounding.issues) console.log(`   - [bull][${issue.reason}] ${issue.title}: ${issue.detail}`);
    for (const issue of bearsGrounding.issues) console.log(`   - [bear][${issue.reason}] ${issue.title}: ${issue.detail}`);
    process.exitCode = 1;
  }

  console.log("\nfull synthesis JSON (check: does thesis actually weigh bulls vs bears, does it respect riskFactors/moat):");
  console.log(JSON.stringify(synthesis, null, 2));

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
