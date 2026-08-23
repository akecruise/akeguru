/**
 * Smoke test for lib/gates/ (Phase 4) — runs runGates() against an existing ResearchReport row.
 *
 *   npx tsx scripts/test-gates.ts <ticker>
 *
 * Prints each gate's pass/fail + notes, and the resulting ResearchReport.gateStatus.
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { runGates } from "../lib/gates";

async function main() {
  const ticker = process.argv[2] ?? "MSFT";
  const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const report = await prisma.researchReport.findFirst({ where: { ticker }, orderBy: { createdAt: "desc" } });
  if (!report) {
    console.log(`no ResearchReport found for ${ticker}`);
    process.exitCode = 1;
    await prisma.$disconnect();
    await pool.end();
    return;
  }

  console.log(`running gates for ResearchReport ${report.id} (${ticker}, dataAsOf=${report.dataAsOf.toISOString().slice(0, 10)})...\n`);
  const result = await runGates(prisma, report.id);

  for (const o of result.outcomes) {
    console.log(`Gate ${o.gateNumber} (${o.gateName}): ${o.passed ? "PASS ✓" : "FAIL ✗"}`);
    console.log(`  ${JSON.stringify(o.notes)}`);
  }

  console.log(`\nrigor: ${result.rigor}`);
  console.log(`gateStatus: ${result.gateStatus}`);

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
