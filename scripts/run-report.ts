/**
 * Runs the full agent pipeline for one ticker (valuation, risk, moat, business, growth, estimates,
 * synthesis — see lib/report/orchestrator.ts) and assembles+validates a StockReport.
 *
 *   npx tsx scripts/run-report.ts MSFT
 *   npx tsx scripts/run-report.ts 1773.HK groq   (provider override — 2nd arg)
 *
 * Costs several LLM calls (6 agent runs) against whichever provider AGENT_PROVIDER/the 2nd arg
 * resolves to — not free-tier-cheap to run repeatedly against gemini's 20/day quota.
 *
 * On success (validateReport passes — the completeness/consistency check equivalent to Gate 5),
 * the ResearchReport row is always saved first (for visibility/audit — this pipeline costs real
 * money per run, nothing gets silently discarded), then runGates() (lib/gates) runs Gate 1-6
 * against the saved row and sets gateStatus. The Obsidian export — the higher-blast-radius action,
 * since it lands in your real personal vault, more likely to be read later without anyone
 * re-checking it — only happens if gateStatus comes back APPROVED (all 6 gates passed, including
 * Gate 1/2's citation checks — the same ones that caught 2 real grounding issues on a live run
 * that had passed validateReport cleanly, see docs/eval/risk.md and docs/eval/synthesis.md,
 * 2026-08-20). A REJECTED report is expected, normal output, not a failure of this script — it
 * means the report needs a human to review the specific gate failures (see QualityGateLog) before
 * anyone treats it as export-ready; this script doesn't retry or auto-fix on its own.
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../generated/prisma/client";
import { runFullReport } from "../lib/report/orchestrator";
import { exportToObsidianVault } from "../lib/report/obsidian-export";
import { printReport } from "../lib/report/print";
import { runGates } from "../lib/gates";
import type { AgentProvider } from "../lib/agents/runner";

async function main() {
  const ticker = process.argv[2] ?? "MSFT";
  const providerOverride = process.argv[3] as AgentProvider | undefined;
  const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  console.log(`running full report pipeline for ${ticker}${providerOverride ? ` (provider=${providerOverride})` : ""}...\n`);
  const result = await runFullReport(prisma, ticker, providerOverride);

  console.log("steps:");
  for (const s of result.steps) {
    const errSuffix = s.errors?.length ? `  errors=${s.errors.join("; ").slice(0, 150)}` : "";
    console.log(`  ${s.agent.padEnd(10)} ${s.ok ? "✓" : "✗"}  ${s.provider}/${s.model}  retry=${s.retryCount}  ${(s.elapsedMs / 1000).toFixed(1)}s${errSuffix}`);
  }

  console.log(`\ntotal elapsed: ${(result.totalElapsedMs / 1000).toFixed(1)}s`);
  console.log(`validation: ${result.validation.ok ? "PASS ✓" : "FAIL ✗"}`);
  if (!result.validation.ok || !result.report) {
    console.log("errors:", result.validation.errors);
    process.exitCode = 1;
    await prisma.$disconnect();
    await pool.end();
    return;
  }

  const report = result.report;
  console.log("");
  console.log(printReport(report));

  const saved = await prisma.researchReport.create({
    data: {
      ticker,
      exchange: report.meta.exchange,
      payload: report as unknown as Prisma.InputJsonValue,
      decision: report.verdict.decision,
      conviction: report.verdict.conviction,
      dataAsOf: new Date(report.meta.dataAsOf),
      modelTier: report.meta.modelTier,
    },
  });
  console.log(`\nsaved ResearchReport ${saved.id}`);

  const gates = await runGates(prisma, saved.id);
  console.log(`\ngates (rigor=${gates.rigor}):`);
  for (const o of gates.outcomes) {
    console.log(`  Gate ${o.gateNumber} (${o.gateName}): ${o.passed ? "PASS ✓" : "FAIL ✗"}`);
    if (!o.passed) console.log(`    ${JSON.stringify(o.notes).slice(0, 300)}`);
  }
  console.log(`gateStatus: ${gates.gateStatus}`);

  if (gates.gateStatus === "APPROVED") {
    const obsidianPath = await exportToObsidianVault(report);
    if (obsidianPath) {
      await prisma.researchReport.update({ where: { id: saved.id }, data: { obsidianPath } });
      console.log(`exported to Obsidian vault: ${obsidianPath}`);
    } else {
      console.log("Obsidian export skipped (OBSIDIAN_VAULT_PATH not set)");
    }
  } else {
    console.log("Obsidian export skipped — gateStatus is REJECTED, see gate failures above (report saved to DB for human review)");
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
