/**
 * Runs the synthesis ("boss") agent against every AgentProvider that has a key configured, for
 * MSFT and 1773.HK. Unlike valuation/risk/moat, synthesis doesn't read raw FinancialFact alone —
 * it reads the already-validated fundamentals/riskFactors/moat output from the prior agents, so
 * this script first fetches (or generates, via gemini, if missing) that context per ticker, then
 * holds it constant while sweeping providers — isolating the variable to "which provider does the
 * decision-making reasoning," same principle as eval-models.ts isolates "which provider does the
 * extraction."
 *
 * Writes docs/eval/synthesis.md.
 *
 *   npx tsx scripts/eval-synthesis.ts
 *
 * Costs money for the anthropic row if ANTHROPIC_API_KEY is set; gemini/groq/ollama are free
 * (gemini/groq up to their free-tier caps).
 */
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { runAgent, type AgentProvider } from "../lib/agents/runner";
import { checkClaimGrounding, type RealFact } from "../lib/agents/grounding";
import { buildSynthesisContext, getOrGenerateSectionOutput } from "../lib/agents/context";
import { RateLimitError } from "../lib/agents/providers/errors";
import type { Synthesis } from "../lib/report/types";

const SYNTHESIS_AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/synthesis.md");
const VALUATION_AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/valuation.md");
const RISK_AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/risk.md");
const MOAT_AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/moat.md");

const PROVIDERS: AgentProvider[] = ["anthropic", "gemini", "groq", "ollama", "xai", "claude-cli"];
const TICKERS = ["MSFT", "1773.HK"];

const PROVIDER_KEY_ENV: Partial<Record<AgentProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  // ollama: no key — availability is whether the local daemon answers, found out by trying
};

interface EvalRow {
  provider: string;
  model: string;
  ticker: string;
  zod: boolean;
  bullsCount: number;
  bearsCount: number;
  groundingOk: boolean;
  groundingIssueCount: number;
  decision: string;
  conviction: number | string;
  retryCount: number;
  elapsedMs: number;
  note: string;
  fullOutput: Synthesis | null;
  groundingIssues: string[];
}

function skippedRow(provider: string, ticker: string, note: string): EvalRow {
  return { provider, model: "-", ticker, zod: false, bullsCount: 0, bearsCount: 0, groundingOk: false, groundingIssueCount: 0, decision: "-", conviction: "-", retryCount: 0, elapsedMs: 0, note, fullOutput: null, groundingIssues: [] };
}

async function evalOne(prisma: PrismaClient, ticker: string, provider: AgentProvider, extraContext: string): Promise<EvalRow> {
  const keyEnv = PROVIDER_KEY_ENV[provider];
  if (keyEnv && !process.env[keyEnv]) {
    return skippedRow(provider, ticker, `skipped: ${keyEnv} not set`);
  }

  try {
    const result = await runAgent(prisma, ticker, SYNTHESIS_AGENT_PATH, "synthesis", provider, extraContext);
    if (!result.ok) {
      return { ...skippedRow(provider, ticker, `zod failed: ${(result.errors?.[0] ?? "").slice(0, 120)}`), model: result.backendModel, retryCount: result.retryCount, elapsedMs: result.elapsedMs };
    }

    const synthesis = result.content as Synthesis;

    const factIds = [...new Set([...synthesis.bulls, ...synthesis.bears].flatMap((c) => c.supportingFactIds))];
    const realFacts: RealFact[] = factIds.length
      ? await prisma.financialFact.findMany({ where: { id: { in: factIds } }, select: { id: true, metricName: true, value: true, unit: true } })
      : [];
    const bullsGrounding = checkClaimGrounding(synthesis.bulls, realFacts);
    const bearsGrounding = checkClaimGrounding(synthesis.bears, realFacts);
    const groundingOk = bullsGrounding.ok && bearsGrounding.ok;
    const groundingIssues = [
      ...bullsGrounding.issues.map((i) => `[bull][${i.reason}] ${i.title}: ${i.detail}`),
      ...bearsGrounding.issues.map((i) => `[bear][${i.reason}] ${i.title}: ${i.detail}`),
    ];

    return {
      provider,
      model: result.backendModel,
      ticker,
      zod: true,
      bullsCount: synthesis.bulls.length,
      bearsCount: synthesis.bears.length,
      groundingOk,
      groundingIssueCount: groundingIssues.length,
      decision: synthesis.verdict.decision,
      conviction: synthesis.verdict.conviction,
      retryCount: result.retryCount,
      elapsedMs: result.elapsedMs,
      note: groundingOk ? "" : `${groundingIssues.length} grounding issue(s), see appendix`,
      fullOutput: synthesis,
      groundingIssues,
    };
  } catch (e) {
    if (e instanceof RateLimitError) return skippedRow(provider, ticker, e.message.slice(0, 150));
    return skippedRow(provider, ticker, `error: ${(e as Error).message}`.slice(0, 150));
  }
}

function fmtBool(b: boolean): string {
  return b ? "✓" : "✗";
}

function table(rows: EvalRow[]): string {
  const header = "| provider | model | zod | bulls | bears | citations ตรง | decision | conviction | retry | เวลา | note |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map(
    (r) =>
      `| ${r.provider} | ${r.model} | ${fmtBool(r.zod)} | ${r.bullsCount} | ${r.bearsCount} | ${r.zod ? fmtBool(r.groundingOk) : "-"} | ${r.decision} | ${r.conviction} | ${r.retryCount} | ${(r.elapsedMs / 1000).toFixed(1)}s | ${r.note} |`,
  );
  return [header, sep, ...body].join("\n");
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const todayIso = new Date().toISOString().slice(0, 10);

  const rowsByTicker: Record<string, EvalRow[]> = {};

  for (const ticker of TICKERS) {
    const factCount = await prisma.financialFact.count({ where: { ticker } });
    if (!factCount) {
      console.log(`skipping ${ticker}: no FinancialFact rows — run scripts/ingest.ts ${ticker} first`);
      continue;
    }

    console.log(`\n${ticker}: loading prior agent context...`);
    const fundamentals = await getOrGenerateSectionOutput(prisma, ticker, "fundamentals", VALUATION_AGENT_PATH);
    const riskFactors = await getOrGenerateSectionOutput(prisma, ticker, "riskFactors", RISK_AGENT_PATH);
    const moat = await getOrGenerateSectionOutput(prisma, ticker, "moat", MOAT_AGENT_PATH);
    const extraContext = buildSynthesisContext(fundamentals, riskFactors, moat, todayIso);

    rowsByTicker[ticker] = [];
    for (const provider of PROVIDERS) {
      process.stdout.write(`${provider} / ${ticker}... `);
      const row = await evalOne(prisma, ticker, provider, extraContext);
      console.log(row.note || `${row.decision} (conviction ${row.conviction})`);
      rowsByTicker[ticker].push(row);
    }
  }

  const lines: string[] = [];
  lines.push('# Synthesis ("boss") agent evaluation');
  lines.push("");
  lines.push(
    "Generated by `scripts/eval-synthesis.ts`. Unlike valuation/risk/moat, this agent's input isn't just FinancialFact — it's the already-validated `fundamentals`/`riskFactors`/`moat` output from those agents (fetched from the latest `AnalysisOutput` row per ticker, or generated fresh via gemini if none existed yet), held constant across the provider sweep below so the only variable is which provider does the decision-making. Agent: `.claude/agents/analysis/synthesis.md`, output: `synthesis` (`{ bulls, bears, verdict }`, where `bulls`/`bears` are now `ClaimItem[]` — `{ claim, supportingFactIds }` — not `string[]`)."
  );
  lines.push("");
  lines.push(
    "**`checkClaimGrounding()` now exists and is run below** (`citations ตรง` column) — checks every `supportingFactIds` entry is real and every financial-looking number in `claim` is within ±5% of a cited fact, same two checks as risk/moat. This replaces a first version of this doc that shipped with no mechanical check at all: that version's manual review looked clean for groq's output because it cited factIds *inline in the prose*, which read as grounded on a skim but wasn't — cross-referencing the DB by hand found 4 of 5 bulls were fabricated. `ClaimItemSchema` now rejects an inline-cited factId outright (zod-level, see `lib/report/schema.ts`), forcing every citation into the checkable `supportingFactIds` array instead."
  );
  lines.push("");

  for (const ticker of TICKERS) {
    if (!rowsByTicker[ticker]) continue;
    lines.push(`## ${ticker}`);
    lines.push("");
    lines.push(table(rowsByTicker[ticker]));
    lines.push("");

    const withIssues = rowsByTicker[ticker].filter((r) => r.groundingIssues.length > 0);
    if (withIssues.length) {
      lines.push("<details><summary>grounding issue details</summary>");
      lines.push("");
      for (const r of withIssues) {
        lines.push(`**${r.provider} (${r.model})**:`);
        for (const d of r.groundingIssues) lines.push(`- ${d}`);
        lines.push("");
      }
      lines.push("</details>");
      lines.push("");
    }

    const passing = rowsByTicker[ticker].filter((r) => r.zod && r.fullOutput);
    if (passing.length) {
      lines.push("<details><summary>full output (zod-passing rows only)</summary>");
      lines.push("");
      for (const r of passing) {
        lines.push(`**${r.provider} (${r.model})**:`);
        lines.push("```json");
        lines.push(JSON.stringify(r.fullOutput, null, 2));
        lines.push("```");
        lines.push("");
      }
      lines.push("</details>");
      lines.push("");
    }
  }

  await fs.mkdir("docs/eval", { recursive: true });
  await fs.writeFile("docs/eval/synthesis.md", lines.join("\n"));
  console.log("\nwrote docs/eval/synthesis.md");

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
