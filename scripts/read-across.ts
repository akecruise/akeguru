/**
 * Read-Across Engine (Phase 4 roadmap item, "fact changes -> rerun related tickers in the graph").
 * Compares a ticker's KEY_METRICS (lib/read-across.ts) now against their value as of its *last*
 * ResearchReport's dataAsOf -- same "closest prior snapshot vs. now" pattern scripts/scorecard.ts
 * already uses for price. If any changed materially, walks the CompanyRelation graph one hop
 * (lib/company-relation.ts, the same traversal scripts/theme-pipeline.ts uses for a theme) and,
 * with --run, re-runs ingest+run-report for the ticker itself and everything related to it.
 *
 * No prior ResearchReport for the ticker means no baseline to compare against -- reported as such,
 * not treated as "no change" (that would be a fabricated signal from missing data, not a real one).
 *
 *   npx tsx scripts/read-across.ts MSFT           (detect + print, no pipeline run)
 *   npx tsx scripts/read-across.ts MSFT --run     (also run ingest.ts + run-report.ts for the ticker and everything related)
 */
import "dotenv/config";
import { spawnSync } from "child_process";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { detectMaterialChanges, KEY_METRICS, MATERIAL_CHANGE_THRESHOLD_PCT } from "../lib/read-across";
import { resolveRelatedTickers } from "../lib/company-relation";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function factValueAsOf(ticker: string, metricName: string, asOf: Date): Promise<number | null> {
  const row = await prisma.financialFact.findFirst({
    where: { ticker, metricName, extractedAt: { lte: asOf } },
    orderBy: { extractedAt: "desc" },
    select: { value: true },
  });
  return row?.value ?? null;
}

async function latestFactValue(ticker: string, metricName: string): Promise<number | null> {
  const row = await prisma.financialFact.findFirst({ where: { ticker, metricName }, orderBy: { extractedAt: "desc" }, select: { value: true } });
  return row?.value ?? null;
}

function runScript(scriptPath: string, ticker: string): boolean {
  const result = spawnSync("npx", ["tsx", scriptPath, ticker], { stdio: "inherit", shell: true });
  return result.status === 0;
}

async function main() {
  const ticker = process.argv[2];
  const shouldRun = process.argv.includes("--run");

  if (!ticker) {
    console.log("usage: npx tsx scripts/read-across.ts <TICKER> [--run]");
    process.exitCode = 1;
    return;
  }

  // dataAsOf is a date, not a timestamp -- createdAt breaks same-day-rerun ties in favor of the
  // actually-most-recent run (found live building scripts/position-sizing.ts: a naive dataAsOf-only
  // sort can resolve a same-day tie to an already-superseded row).
  const lastReport = await prisma.researchReport.findFirst({ where: { ticker }, orderBy: [{ dataAsOf: "desc" }, { createdAt: "desc" }] });
  if (!lastReport) {
    console.log(`no prior ResearchReport for ${ticker} -- nothing to compare against, can't detect a change`);
    return;
  }

  const oldValues: Partial<Record<(typeof KEY_METRICS)[number], number | null>> = {};
  const newValues: Partial<Record<(typeof KEY_METRICS)[number], number | null>> = {};
  for (const metricName of KEY_METRICS) {
    oldValues[metricName] = await factValueAsOf(ticker, metricName, lastReport.dataAsOf);
    newValues[metricName] = await latestFactValue(ticker, metricName);
  }

  const changes = detectMaterialChanges(oldValues, newValues);
  console.log(`${ticker}: comparing against last report (dataAsOf=${lastReport.dataAsOf.toISOString().slice(0, 10)})`);
  for (const metricName of KEY_METRICS) {
    const o = oldValues[metricName];
    const n = newValues[metricName];
    console.log(`  ${metricName.padEnd(24)} ${o ?? "—"} -> ${n ?? "—"}`);
  }

  if (!changes.length) {
    console.log(`\nno metric moved >= ${MATERIAL_CHANGE_THRESHOLD_PCT}% -- nothing to propagate`);
    return;
  }

  console.log(`\n${changes.length} material change(s):`);
  for (const c of changes) console.log(`  ${c.metricName}: ${c.oldValue.toLocaleString()} -> ${c.newValue.toLocaleString()} (${c.changePct >= 0 ? "+" : ""}${c.changePct.toFixed(1)}%)`);

  const related = await resolveRelatedTickers(prisma, [ticker], "changed ticker");
  console.log(`\n${related.length} ticker(s) in the read-across chain:`);
  for (const m of related) console.log(`  ${m.ticker.padEnd(10)} ${m.role}`);

  if (!shouldRun) {
    console.log("\n(dry run -- pass --run to also run ingest.ts + run-report.ts for every ticker above)");
    return;
  }

  console.log(`\nRunning ingest + full report pipeline for ${related.length} ticker(s)...`);
  const failures: string[] = [];
  for (const { ticker: t } of related) {
    console.log(`\n${"#".repeat(60)}\n# ${t}\n${"#".repeat(60)}`);
    if (!runScript("scripts/ingest.ts", t)) {
      console.error(`  ingest failed for ${t} -- skipping run-report`);
      failures.push(t);
      continue;
    }
    if (!runScript("scripts/run-report.ts", t)) failures.push(t);
  }

  console.log(`\ndone. ${related.length - failures.length}/${related.length} ticker(s) completed without error.`);
  if (failures.length) console.log(`failed: ${failures.join(", ")}`);
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
