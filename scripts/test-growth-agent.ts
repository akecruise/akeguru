/**
 * Layer 3 smoke test — runs the growth agent for a real ticker against real FinancialFact rows
 * already in the DB (run scripts/ingest.ts <TICKER> first).
 *
 *   npx tsx scripts/test-growth-agent.ts MSFT
 *
 * Calls whichever backend AGENT_PROVIDER resolves to (see lib/agents/runner.ts) — gemini/groq/
 * ollama are free, anthropic/xai cost money or need a key.
 *
 * Pass criteria:
 *   1. output passes zod (validateSection inside runAgent already enforces this — every
 *      BulletItem has supportingFactIds with >=1 entry)
 *   2-3. lib/agents/grounding.ts's checkBulletGrounding(): every supportingFactIds entry exists
 *        in FinancialFact, and every financial-looking number in body/example is within ±5% of
 *        some fact among that bullet's supportingFactIds — see scripts/test-grounding.ts for the
 *        regression tests behind these two checks.
 *
 * Two things the code can't check are printed in full below for manual read-through instead:
 *   - whether `example` is a genuinely concrete scenario, or just "For example," + a restatement
 *     of `body`
 *   - whether a growth driver just re-describes a riskFactors item from the opposite angle instead
 *     of naming a genuinely distinct upside (growth.md's rule against this — needs a human read
 *     against the ticker's riskFactors output, checkBulletGrounding can't see across sections)
 */
import "dotenv/config";
import path from "path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { runAgent } from "../lib/agents/runner";
import { checkBulletGrounding, type RealFact } from "../lib/agents/grounding";
import type { BulletItem } from "../lib/report/types";

const AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/growth.md");

async function main() {
  const ticker = process.argv[2] ?? "MSFT";
  const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  console.log(`running growth agent for ${ticker}...`);
  const result = await runAgent(prisma, ticker, AGENT_PATH, "growthDrivers");

  console.log(`\nok=${result.ok} retryCount=${result.retryCount} modelTier=${result.modelTier} provider=${result.provider}/${result.backendModel} elapsedMs=${result.elapsedMs}`);
  if (!result.ok) {
    console.log("errors:", result.errors);
    process.exitCode = 1;
    await prisma.$disconnect();
    await pool.end();
    return;
  }
  console.log("1. zod validation: PASS ✓ (enforced inside runAgent before save)");

  const growthDrivers = result.content as BulletItem[];
  console.log(`\n${growthDrivers.length} growth driver item(s)`);

  const factIds = [...new Set(growthDrivers.flatMap((b) => b.supportingFactIds))];
  const realFacts: RealFact[] = factIds.length
    ? await prisma.financialFact.findMany({
        where: { id: { in: factIds } },
        select: { id: true, metricName: true, value: true, unit: true },
      })
    : [];

  const grounding = checkBulletGrounding(growthDrivers, realFacts);
  console.log(`\n2-3. bullet grounding check (exhaustive over all ${grounding.checkedCount} item(s)):`);
  if (grounding.ok) {
    console.log("   PASS ✓ — every supportingFactIds entry exists, every financial-looking number is within ±5% of a cited fact");
  } else {
    console.log(`   FAIL ✗ — ${grounding.issues.length} issue(s):`);
    for (const issue of grounding.issues) console.log(`   - [${issue.reason}] ${issue.title}: ${issue.detail}`);
    process.exitCode = 1;
  }

  console.log("\nfull growthDrivers JSON (read example vs body, and check against riskFactors output for the same ticker for opposite-angle duplicates):");
  console.log(JSON.stringify(growthDrivers, null, 2));

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
