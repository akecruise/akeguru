/**
 * Layer 3 smoke test — runs the moat agent for a real ticker against real FinancialFact rows
 * already in the DB (run scripts/ingest.ts <TICKER> first).
 *
 *   npx tsx scripts/test-moat-agent.ts MSFT
 *
 * Calls whichever backend AGENT_PROVIDER resolves to (see lib/agents/runner.ts) — gemini/groq/
 * ollama are free, anthropic/xai cost money or need a key.
 *
 * Pass criteria:
 *   1. output passes zod (validateSection inside runAgent already enforces this — every
 *      MoatItem has supportingFactIds with >=1 entry)
 *   2-3. lib/agents/grounding.ts's checkMoatGrounding(): every supportingFactIds entry exists
 *        in FinancialFact, and every financial-looking number in body is within ±5% of some fact
 *        among that item's supportingFactIds — see scripts/test-grounding.ts cases 10-13 for the
 *        regression tests behind these two checks.
 *
 * Things the code can't check, printed in full below for manual read-through instead:
 *   - scale_economies/process_power actually cite a real Revenue/Margin number (Gate 1 rule #3
 *     in moat.md — zod/checkMoatGrounding don't enforce this, only the prompt does)
 *   - the qualitative types (brand/switching_costs/network_economies/counter_positioning/
 *     cornered_resource) cite supportingFactIds that are genuine indirect evidence, not a fact
 *     grabbed just to satisfy the schema's min-1 requirement
 *   - 'none' is used honestly (not padded in just to hit "at least 1 item") and, conversely, not
 *     used to dodge a moat that the facts actually do support
 */
import "dotenv/config";
import path from "path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { runAgent } from "../lib/agents/runner";
import { checkMoatGrounding, type RealFact } from "../lib/agents/grounding";
import type { MoatItem } from "../lib/report/types";

const AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/moat.md");

async function main() {
  const ticker = process.argv[2] ?? "MSFT";
  const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  console.log(`running moat agent for ${ticker}...`);
  const result = await runAgent(prisma, ticker, AGENT_PATH, "moat");

  console.log(`\nok=${result.ok} retryCount=${result.retryCount} modelTier=${result.modelTier} provider=${result.provider}/${result.backendModel} elapsedMs=${result.elapsedMs}`);
  if (!result.ok) {
    console.log("errors:", result.errors);
    process.exitCode = 1;
    await prisma.$disconnect();
    await pool.end();
    return;
  }
  console.log("1. zod validation: PASS ✓ (enforced inside runAgent before save)");

  const moat = result.content as MoatItem[];
  console.log(`\n${moat.length} moat item(s): ${moat.map((m) => m.type).join(", ")}`);

  const factIds = [...new Set(moat.flatMap((m) => m.supportingFactIds))];
  const realFacts: RealFact[] = factIds.length
    ? await prisma.financialFact.findMany({
        where: { id: { in: factIds } },
        select: { id: true, metricName: true, value: true, unit: true },
      })
    : [];

  const grounding = checkMoatGrounding(moat, realFacts);
  console.log(`\n2-3. moat grounding check (exhaustive over all ${grounding.checkedCount} item(s)):`);
  if (grounding.ok) {
    console.log("   PASS ✓ — every supportingFactIds entry exists, every financial-looking number is within ±5% of a cited fact");
  } else {
    console.log(`   FAIL ✗ — ${grounding.issues.length} issue(s):`);
    for (const issue of grounding.issues) console.log(`   - [${issue.reason}] ${issue.title}: ${issue.detail}`);
    process.exitCode = 1;
  }

  console.log("\nfull moat JSON (check: scale_economies/process_power cite real numbers, qualitative types cite genuine indirect evidence, 'none' used honestly):");
  console.log(JSON.stringify(moat, null, 2));

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
