/**
 * Phase 1 — pull data into RawSource + FinancialFact
 *
 *   npx tsx scripts/ingest.ts 1773.HK
 *   npx tsx scripts/ingest.ts MSFT PTT.BK 1773.HK
 *   npx tsx scripts/ingest.ts --dry 1773.HK     (no DB writes, just prints what it found)
 *
 * No AI involved — 0 tokens.
 */

import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { ingest, mapYahooFacts, mapYahooEarningsTrendFacts } from "../lib/data/input-sources/router";
import { STATEMENT_BY_TAG, SPLIT_ADJUSTED_BY_TAG } from "../lib/data/input-sources/sec";
import { computeAllDerivedMetrics } from "../lib/data/derived-metrics";

// Standalone CLI script: build its own client against the DIRECT (unpooled) connection,
// same reasoning as scripts/refresh-universe.ts.
const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL_UNPOOLED });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function run(ticker: string, dry: boolean) {
  console.log(`\n${"=".repeat(56)}\n  ${ticker}\n${"=".repeat(56)}`);

  const r = await ingest(ticker);
  console.log(`market: ${r.exchange}   yahoo: ${r.yahooTicker}`);

  for (const w of r.warnings) console.warn(`  ⚠ ${w}`);

  // ---- Gate 0 ----
  const y = Array.isArray(r.gate0.years) ? r.gate0.years.length : r.gate0.years;
  console.log(`Gate 0 [${r.gate0.source}]: ${y} years -> ${r.gate0.passed ? "PASS" : "FAIL"}`);
  if (!r.gate0.passed) {
    console.log("  skipping — less than 3 years of history available");
    return;
  }

  if (dry) {
    console.log(`\n[dry] rawSources=${r.rawSources.length} facts=${r.facts.length}`);
    r.rawSources.forEach((s) => console.log(`  ${s.market.padEnd(7)} ${s.filePath}`));
    return;
  }

  // ---- RawSource (dedup via sha256) ----
  const ids: Record<string, string> = {};
  let created = 0,
    skipped = 0;

  for (const s of r.rawSources) {
    const existing = await prisma.rawSource.findUnique({ where: { sha256Hash: s.sha256Hash } });
    if (existing) {
      ids[s.market] = existing.id;
      skipped++;
      continue;
    }
    const row = await prisma.rawSource.create({
      data: {
        ticker: s.ticker,
        market: s.market,
        filePath: s.filePath,
        sha256Hash: s.sha256Hash,
        sourceUrl: s.sourceUrl ?? null,
        fiscalPeriod: s.fiscalPeriod ?? null,
        fetchedBy: s.fetchedBy,
      },
    });
    ids[s.market] = row.id;
    created++;
  }
  console.log(`RawSource: created ${created} / skipped ${skipped} (hash already seen)`);

  // ---- FinancialFact ----
  const facts: any[] = [];

  // Yahoo ratios -> mapped by code
  if (r.yahooData && ids["YAHOO"]) {
    facts.push(...mapYahooFacts(r.yahooData, ids["YAHOO"], r.ticker));
    facts.push(...mapYahooEarningsTrendFacts(r.yahooData, ids["YAHOO"], r.ticker));
  }

  // facts from SEC/ก.ล.ต. — attached to that market's rawSource
  const officialId = ids["SEC"] ?? ids["TH_SEC"];
  if (officialId) {
    for (const f of r.facts) {
      // f.statementType exists on th.ts's ThFinancialRow (its own field, from ก.ล.ต.'s
      // financial_statement) but NOT on sec.ts's SecFactRow (`f.statementType` was always
      // undefined here, silently -- both types flow through this one untyped loop, and nothing
      // caught it) -- fall back to STATEMENT_BY_TAG, which covers the SEC/XBRL tag case instead.
      const statement = f.statementType ?? STATEMENT_BY_TAG[f.metricName as keyof typeof STATEMENT_BY_TAG] ?? null;
      // form (10-K/10-Q) only exists on SecFactRow -- th.ts's rows have nothing more specific than
      // metricName itself to disambiguate (TH_SET_CODE_MAP is still empty, see th.ts), so null there.
      const sourceDefinition = f.form ? `us-gaap:${f.metricName} (${f.form})` : null;
      const splitAdjusted =
        (f.metricName as string) in SPLIT_ADJUSTED_BY_TAG
          ? SPLIT_ADJUSTED_BY_TAG[f.metricName as keyof typeof SPLIT_ADJUSTED_BY_TAG]!
          : null;

      facts.push({
        rawSourceId: officialId,
        ticker: r.ticker,
        metricName: f.metricName,
        value: f.value,
        unit: f.unit,
        period: f.period,
        statement,
        sourceDefinition,
        splitAdjusted,
        extractedBy: `${r.exchange}_MAP`,
      });
    }
  }

  // guard: every fact must have a rawSourceId
  const orphan = facts.filter((f) => !f.rawSourceId);
  if (orphan.length) throw new Error(`${orphan.length} fact row(s) missing rawSourceId — aborting`);

  const res = await prisma.financialFact.createMany({ data: facts, skipDuplicates: true });
  console.log(`FinancialFact: wrote ${res.count} / ${facts.length} total`);

  // ---- key numbers summary ----
  const key = ["P/E", "ROE", "Debt/Equity", "Revenue", "Market Cap"];
  const shown = await prisma.financialFact.findMany({
    where: { ticker: r.ticker, metricName: { in: key } },
    orderBy: { extractedAt: "desc" },
    take: 20,
  });
  const seen = new Set<string>();
  console.log("\nkey numbers:");
  for (const f of shown) {
    if (seen.has(f.metricName)) continue;
    seen.add(f.metricName);
    console.log(`  ${f.metricName.padEnd(14)} ${fmt(f.value, f.unit)}`);
  }
  for (const k of key) if (!seen.has(k)) console.log(`  ${k.padEnd(14)} — (none)`);

  // ---- derived metrics (Phase 2 — code-only, computed from facts already written above) ----
  const allFacts = await prisma.financialFact.findMany({
    where: { ticker: r.ticker },
    select: { metricName: true, value: true, period: true },
  });
  console.log("\nderived metrics:");
  for (const m of computeAllDerivedMetrics(allFacts)) {
    if (m.value == null) {
      console.log(`  ${m.name.padEnd(20)} — (missing: ${m.missing?.join(", ") ?? "?"})`);
    } else {
      console.log(`  ${m.name.padEnd(20)} ${fmt(m.value, m.unit)}`);
    }
  }
}

function fmt(v: number, unit: string) {
  if (unit === "currency" || unit === "count") {
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
    return v.toLocaleString();
  }
  if (unit === "%") return v.toFixed(1) + "%";
  return v.toFixed(2);
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const tickers = args.filter((a) => !a.startsWith("--"));

  if (!tickers.length) {
    console.error("usage: npx tsx scripts/ingest.ts <TICKER> [...] [--dry]");
    process.exitCode = 1;
    return;
  }

  for (const t of tickers) {
    try {
      await run(t, dry);
    } catch (e) {
      console.error(`\n✗ ${t}: ${(e as Error).message}`);
    }
  }
  await prisma.$disconnect();
  await pool.end();
}

main();
