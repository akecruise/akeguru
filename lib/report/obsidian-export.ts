/**
 * Renders a StockReport as Obsidian-vault markdown and writes it into the real vault
 * (`OBSIDIAN_VAULT_PATH`, see .env) under `09_Investment_Thesis/<Market>/`. Pure formatting, no
 * LLM — same reasoning as lib/report/estimates.ts. Auto-triggered by scripts/run-report.ts after a
 * successful orchestrator run (validateReport passed, ResearchReport saved).
 *
 * Folder + filename convention chosen after inspecting the real vault (not invented blind):
 * `03_Stocks/<Market>/<TICKER> - <date>.md` already exists there for a different, raw-financials
 * document type (from another pipeline). `09_Investment_Thesis/` was empty but named for exactly
 * this content (verdict/thesis/bulls/bears) — reused its market-subfolder + "TICKER - date.md"
 * dated-filename pattern (not a single evergreen note) so re-running the pipeline later preserves
 * history instead of silently overwriting a prior thesis.
 */
import fs from "fs/promises";
import path from "path";
import type { StockReport, MetricGroup, ClaimItem, BulletItem, MoatItem, EstimateBlock, Exchange } from "./types";

const MARKET_FOLDER: Record<Exchange, string> = {
  SEC: "USA",
  HKEX: "HongKong",
  SET: "Thailand",
};

function fmtValue(value: number | null, unit: string): string {
  if (value === null) return "—";
  switch (unit) {
    case "%":
      return `${value.toFixed(2)}%`;
    case "x":
      return `${value.toFixed(2)}x`;
    case "currency": {
      const abs = Math.abs(value);
      if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
      if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
      return `$${value.toLocaleString()}`;
    }
    case "count":
      return value.toLocaleString();
    default:
      return String(value);
  }
}

function renderMetricGroup(group: MetricGroup): string {
  if (!group.metrics.length) return "_no metrics available_";
  const rows = group.metrics.map((m) => `| ${m.name} | ${fmtValue(m.value, m.unit)} |`);
  return ["| Metric | Value |", "|---|---|", ...rows].join("\n");
}

function renderClaims(items: ClaimItem[]): string {
  if (!items.length) return "_none_";
  return items.map((c) => `- ${c.claim}`).join("\n");
}

function renderBullets(items: BulletItem[]): string {
  if (!items.length) return "_none_";
  return items.map((b) => `### ${b.title}\n\n${b.body}\n\n> ${b.example}`).join("\n\n");
}

function renderMoat(items: MoatItem[]): string {
  if (!items.length) return "_none_";
  return items.map((m) => `### ${m.title} (\`${m.type}\`, strength: ${m.strength})\n\n${m.body}`).join("\n\n");
}

function renderEstimates(blocks: EstimateBlock[]): string {
  if (!blocks.length) return "_no consensus estimates available_";
  return blocks
    .map((b) => {
      if (!b.consensus) return `### ${b.metric}\n\n_no consensus_`;
      const c = b.consensus;
      const header = `| | ${b.periods.join(" | ")} |`;
      const sep = `|---|${b.periods.map(() => "---").join("|")}|`;
      const mean = `| Mean | ${c.mean.map((v) => (v === null ? "—" : v.toLocaleString())).join(" | ")} |`;
      const numEst = `| # Analysts | ${c.numEstimates.map((v) => (v === null ? "—" : String(v))).join(" | ")} |`;
      const coverage = c.lowCoverage ? "\n\n> ⚠️ Low analyst coverage (<3 estimates for at least one period)" : "";
      return `### ${b.metric}\n\n${header}\n${sep}\n${mean}\n${numEst}${coverage}`;
    })
    .join("\n\n");
}

export function renderStockReportMarkdown(report: StockReport): string {
  const { meta, verdict, fundamentals } = report;

  const frontmatter = [
    "---",
    `ticker: ${meta.ticker}`,
    `company: "${meta.companyName.replace(/"/g, '\\"')}"`,
    `exchange: ${meta.exchange}`,
    `currency: ${meta.currency}`,
    `decision: ${verdict.decision}`,
    `conviction: ${verdict.conviction}`,
    `generated: ${meta.generatedAt}`,
    `data_as_of: ${meta.dataAsOf}`,
    `review_date: ${verdict.reviewDate}`,
    `tags: [investment-thesis, compound-os, ${meta.ticker.toLowerCase().replace(/[^a-z0-9]/g, "")}]`,
    "---",
  ].join("\n");

  const fundamentalsGroups: [string, MetricGroup | null][] = [
    ["Profile", fundamentals.profile],
    ["Margins", fundamentals.margins],
    ["Returns", fundamentals.returns],
    ["Valuation (TTM)", fundamentals.valuationTTM],
    ["Valuation (NTM)", fundamentals.valuationNTM],
    ["Financial Health", fundamentals.financialHealth],
    ["Growth", fundamentals.growth],
    ["Dividends", fundamentals.dividends],
  ];
  const fundamentalsSection = fundamentalsGroups
    .filter((entry): entry is [string, MetricGroup] => entry[1] !== null)
    .map(([label, group]) => `### ${label}\n\n${renderMetricGroup(group)}`)
    .join("\n\n");

  const blocks = [
    `# ${meta.companyName} (${meta.ticker}) — Investment Thesis`,
    `**Decision: ${verdict.decision}** (conviction ${verdict.conviction}/5) — review by ${verdict.reviewDate}`,
    `## Thesis\n\n${verdict.thesis}`,
    `## Kill Criteria\n\n${verdict.killCriteria.map((k) => `- ${k}`).join("\n")}`,
    `## Bulls\n\n${renderClaims(report.bulls)}`,
    `## Bears\n\n${renderClaims(report.bears)}`,
    `## Business Summary\n\n${renderClaims(report.businessSummary)}`,
    `## Fundamentals\n\n${fundamentalsSection}`,
    `## Moat\n\n${renderMoat(report.moat)}`,
    `## Risk Factors\n\n${renderBullets(report.riskFactors)}`,
    `## Growth Drivers\n\n${renderBullets(report.growthDrivers)}`,
    `## Consensus Estimates\n\n${renderEstimates(report.estimates)}`,
  ];

  return `${frontmatter}\n\n${blocks.join("\n\n")}\n`;
}

/** Relative to the vault root — this is what gets stored in ResearchReport.obsidianPath. */
export function obsidianRelativePath(report: StockReport): string {
  const folder = MARKET_FOLDER[report.meta.exchange];
  const safeTicker = report.meta.ticker.replace(/[\\/:*?"<>|]/g, "_");
  return path.posix.join("09_Investment_Thesis", folder, `${safeTicker} - ${report.meta.dataAsOf}.md`);
}

/**
 * Writes the rendered report into the real vault. Returns the relative path on success, or null if
 * OBSIDIAN_VAULT_PATH isn't configured (export silently skipped — matches scripts/sync-notes.ts's
 * existing "not configured -> no-op" convention rather than failing the whole report pipeline over
 * an optional feature).
 */
export async function exportToObsidianVault(report: StockReport): Promise<string | null> {
  const vaultRoot = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRoot) return null;

  const relativePath = obsidianRelativePath(report);
  const fullPath = path.join(vaultRoot, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, renderStockReportMarkdown(report), "utf-8");
  return relativePath;
}
