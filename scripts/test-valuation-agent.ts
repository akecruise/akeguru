/**
 * Layer 3 smoke test — runs the valuation agent for a real ticker against real FinancialFact
 * rows already in the DB (run scripts/ingest.ts <TICKER> first).
 *
 *   npx tsx scripts/test-valuation-agent.ts MSFT
 *
 * Calls the real Anthropic API (costs money — this is not a dry run), or falls back to local
 * Ollama if ANTHROPIC_API_KEY isn't set (see lib/agents/runner.ts).
 *
 * Pass criteria:
 *   1. output passes zod (validateSection inside runAgent already enforces this)
 *   2-4. lib/agents/grounding.ts's checkGrounding(): every valued metric's factId exists, its
 *        value matches FinancialFact.value, and its name plausibly matches FinancialFact.metricName
 *        — see scripts/test-grounding.ts for the regression tests behind these three checks.
 */
import "dotenv/config";
import path from "path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { runAgent } from "../lib/agents/runner";
import { checkGrounding, allMetrics, type RealFact } from "../lib/agents/grounding";
import type { Fundamentals } from "../lib/report/types";

const AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/valuation.md");

async function main() {
  const ticker = process.argv[2] ?? "MSFT";
  const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  console.log(`running valuation agent for ${ticker}...`);
  const result = await runAgent(prisma, ticker, AGENT_PATH, "fundamentals");

  console.log(`\nok=${result.ok} retryCount=${result.retryCount} modelTier=${result.modelTier}`);
  if (!result.ok) {
    console.log("errors:", result.errors);
    process.exitCode = 1;
    await prisma.$disconnect();
    await pool.end();
    return;
  }
  console.log("1. zod validation: PASS ✓ (enforced inside runAgent before save)");

  const fundamentals = result.content as Fundamentals;
  const metrics = allMetrics(fundamentals);
  const withValue = metrics.filter((m) => m.value !== null);
  console.log(`\n${metrics.length} metrics total, ${withValue.length} with a value`);

  const factIds = [...new Set(withValue.map((m) => m.factId).filter((id): id is string => id !== null))];
  const realFacts: RealFact[] = await prisma.financialFact.findMany({
    where: { id: { in: factIds } },
    select: { id: true, metricName: true, value: true, unit: true },
  });

  const grounding = checkGrounding(fundamentals, realFacts);
  console.log(`\n2-4. grounding check (exhaustive over all ${grounding.checkedCount} valued metrics):`);
  if (grounding.ok) {
    console.log("   PASS ✓ — every metric's factId exists, value matches, and name plausibly matches FinancialFact.metricName");
  } else {
    console.log(`   FAIL ✗ — ${grounding.issues.length} issue(s):`);
    for (const issue of grounding.issues) console.log(`   - [${issue.reason}] ${issue.metricName}: ${issue.detail}`);
    process.exitCode = 1;
  }

  // human-readable spot-check sample, for eyeballing
  const sampleSize = Math.min(3, withValue.length);
  const sample = [...withValue].sort(() => Math.random() - 0.5).slice(0, sampleSize);
  console.log(`\nspot-check sample (${sampleSize} random metric(s)):`);
  for (const m of sample) {
    const fact = realFacts.find((f) => f.id === m.factId);
    console.log(`   ${m.name.padEnd(20)} agent=${m.value}  fact=${fact ? `${fact.metricName}=${fact.value}` : "(none found)"}`);
  }

  console.log("\nfull fundamentals JSON:");
  console.log(JSON.stringify(fundamentals, null, 2));

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
