/**
 * Formats a StockReport as readable terminal text — used by scripts/run-report.ts instead of
 * dumping the raw JSON, so `npx tsx scripts/run-report.ts <ticker>` is actually readable at a
 * glance rather than requiring a JSON viewer.
 */
import type { StockReport, MetricGroup, ClaimItem, BulletItem, MoatItem, FactorExposure } from "./types";

const RULE = "=".repeat(80);
const SUBRULE = "-".repeat(80);

function fmtValue(v: number | null, unit: string): string {
  if (v === null) return "—";
  switch (unit) {
    case "%":
      return `${v.toFixed(2)}%`;
    case "x":
      return `${v.toFixed(2)}x`;
    case "currency":
      return Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${v.toLocaleString()}`;
    case "count":
      return v.toLocaleString();
    default:
      return String(v);
  }
}

function printMetricGroup(g: MetricGroup): string {
  const lines = [`  ${g.label}`];
  for (const m of g.metrics) {
    lines.push(`    ${m.name.padEnd(28)} ${fmtValue(m.value, m.unit)}`);
  }
  return lines.join("\n");
}

function printClaims(items: ClaimItem[], label: string): string {
  if (!items.length) return "";
  const lines = [label];
  items.forEach((c, i) => lines.push(`  ${i + 1}. ${c.claim}`));
  return lines.join("\n");
}

function printBullets(items: BulletItem[], label: string): string {
  if (!items.length) return "";
  const lines = [label];
  items.forEach((b, i) => {
    lines.push(`  ${i + 1}. ${b.title}`);
    lines.push(`     ${b.body}`);
    lines.push(`     e.g. ${b.example}`);
  });
  return lines.join("\n");
}

function printMoat(items: MoatItem[]): string {
  if (!items.length) return "";
  const lines = ["MOAT"];
  items.forEach((m, i) => {
    lines.push(`  ${i + 1}. [${m.type} / ${m.strength}] ${m.title}`);
    lines.push(`     ${m.body}`);
  });
  return lines.join("\n");
}

function printFactorSensitivity(items: FactorExposure[]): string {
  if (!items.length) return "";
  const lines = ["FACTOR SENSITIVITY"];
  items.forEach((f, i) => {
    const arrow = f.direction === "positive" ? "benefits" : "hurt";
    lines.push(`  ${i + 1}. [${f.factor} / ${f.weight}] ${f.title}  (${arrow} when it rises)`);
    lines.push(`     ${f.body}`);
  });
  return lines.join("\n");
}

export function printReport(report: StockReport): string {
  const { meta, verdict } = report;
  const out: string[] = [];

  out.push(RULE);
  out.push(`${meta.ticker} — ${meta.companyName} (${meta.exchange})`);
  out.push(`generated: ${meta.generatedAt.slice(0, 19).replace("T", " ")} | data as of: ${meta.dataAsOf} | model: ${meta.modelTier}`);
  out.push(RULE);
  out.push("");

  out.push(`VERDICT: ${verdict.decision}  (conviction ${verdict.conviction}/5)  — review by ${verdict.reviewDate}`);
  out.push("");
  out.push(verdict.thesis);
  out.push("");

  const gap = report.expectationGap;
  out.push("Expectation gap (reverse DCF):");
  if (gap) {
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    out.push(`  ${gap.classification}  —  implied ${pct(gap.impliedGrowthRate)} vs. achievable ${pct(gap.achievableGrowthRate)}  (gap ${gap.gapPct >= 0 ? "+" : ""}${gap.gapPct.toFixed(1)}pp, required return ${pct(gap.requiredReturn)})`);
  } else {
    out.push("  not computed (insufficient data)");
  }
  out.push("");

  out.push("Kill criteria:");
  for (const k of verdict.killCriteria) out.push(`  - ${k}`);
  out.push("");
  out.push("Invalidation triggers:");
  for (const t of verdict.invalidationTriggers) {
    const cmp = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[t.comparator];
    out.push(`  - ${t.description}  [${t.metricName} ${cmp} ${t.threshold}]`);
  }
  out.push("");

  out.push(SUBRULE);
  out.push("FUNDAMENTALS");
  const f = report.fundamentals;
  for (const g of [f.profile, f.margins, f.returns, f.valuationTTM, f.valuationNTM, f.financialHealth, f.growth, f.dividends]) {
    if (g) out.push(printMetricGroup(g));
  }
  out.push("");

  out.push(SUBRULE);
  out.push(printClaims(report.businessSummary, "BUSINESS SUMMARY"));
  out.push("");

  const growth = printBullets(report.growthDrivers, "GROWTH DRIVERS");
  if (growth) {
    out.push(SUBRULE);
    out.push(growth);
    out.push("");
  }

  const risk = printBullets(report.riskFactors, "RISK FACTORS");
  if (risk) {
    out.push(SUBRULE);
    out.push(risk);
    out.push("");
  }

  const moat = printMoat(report.moat);
  if (moat) {
    out.push(SUBRULE);
    out.push(moat);
    out.push("");
  }

  const factorSensitivity = printFactorSensitivity(report.factorSensitivity);
  if (factorSensitivity) {
    out.push(SUBRULE);
    out.push(factorSensitivity);
    out.push("");
  }

  out.push(SUBRULE);
  out.push(printClaims(report.bulls, "BULLS"));
  out.push("");
  out.push(printClaims(report.bears, "BEARS"));
  out.push("");
  out.push(RULE);

  return out.join("\n");
}
