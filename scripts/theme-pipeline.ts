/**
 * Theme Agent (Phase 3 roadmap item, "Theme Agent (top-down: theme -> value chain -> company ->
 * pipeline)") — resolves a theme's full value chain from data already recorded in this pipeline
 * (Stock.themes + CompanyRelation), then optionally runs ingest+run-report for the whole chain.
 * Mechanical graph traversal over facts you already entered, not agent judgment (same reasoning as
 * lib/data/expectation-gap.ts) — no LLM call happens in this script itself. Discovering *new*
 * relations an LLM would have to infer is explicitly out of scope, same reasoning as
 * prisma/schema.prisma's CompanyRelation doc comment: manually entered for now, no inference agent
 * exists yet, and a wrong inferred relation silently expanding what gets ingested/reported (and
 * costs real pipeline time) would be worse than a chain that's smaller than it could be.
 *
 * "Value chain" here means one hop out from the theme's tagged members via CompanyRelation, in
 * either direction (supplier/customer/competitor/beneficiary of a theme member) — not a
 * multi-hop graph walk, which would risk pulling in loosely-related companies with no clear
 * connection to the theme itself.
 *
 *   npx tsx scripts/theme-pipeline.ts "AI Infrastructure"          (resolve + print, no pipeline run)
 *   npx tsx scripts/theme-pipeline.ts "AI Infrastructure" --run    (also run ingest.ts + run-report.ts for every ticker in the chain)
 */
import "dotenv/config";
import { spawnSync } from "child_process";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { resolveRelatedTickers, type RelatedTicker } from "../lib/company-relation";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function resolveValueChain(theme: string): Promise<RelatedTicker[]> {
  const coreStocks = await prisma.stock.findMany({ where: { themes: { has: theme } }, select: { ticker: true } });
  return resolveRelatedTickers(prisma, coreStocks.map((s) => s.ticker), "core theme member");
}

function runScript(scriptPath: string, ticker: string): boolean {
  const result = spawnSync("npx", ["tsx", scriptPath, ticker], { stdio: "inherit", shell: true });
  return result.status === 0;
}

async function main() {
  const theme = process.argv[2];
  const shouldRun = process.argv.includes("--run");

  if (!theme) {
    console.log('usage: npx tsx scripts/theme-pipeline.ts "<theme>" [--run]');
    process.exitCode = 1;
    return;
  }

  const chain = await resolveValueChain(theme);
  if (!chain.length) {
    console.log(`no stock is tagged with theme "${theme}" (Stock.themes) -- nothing to resolve. Set it via the theme UI/db, or check spelling.`);
    return;
  }

  console.log(`Value chain for theme "${theme}": ${chain.length} ticker(s)\n`);
  const coreCount = chain.filter((m) => m.role === "core theme member").length;
  for (const m of chain) console.log(`  ${m.ticker.padEnd(10)} ${m.role}`);
  console.log(`\n${coreCount} core theme member(s), ${chain.length - coreCount} pulled in via CompanyRelation`);

  if (!shouldRun) {
    console.log("\n(dry run -- pass --run to also run ingest.ts + run-report.ts for every ticker above)");
    return;
  }

  console.log(`\nRunning ingest + full report pipeline for ${chain.length} ticker(s)...`);
  const failures: string[] = [];
  for (const { ticker } of chain) {
    console.log(`\n${"#".repeat(60)}\n# ${ticker}\n${"#".repeat(60)}`);
    if (!runScript("scripts/ingest.ts", ticker)) {
      console.error(`  ingest failed for ${ticker} -- skipping run-report`);
      failures.push(ticker);
      continue;
    }
    if (!runScript("scripts/run-report.ts", ticker)) {
      failures.push(ticker);
    }
  }

  console.log(`\ndone. ${chain.length - failures.length}/${chain.length} ticker(s) completed without error.`);
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
