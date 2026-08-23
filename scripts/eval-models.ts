/**
 * Runs the valuation agent against every AgentProvider that has a key configured, for both MSFT
 * (SEC-sourced, 6 years, dense) and 1773.HK (Yahoo-only, sparse — checks whether a model is
 * willing to emit null for a metric it has no fact for, vs. fabricating one). Writes
 * docs/eval/valuation.md — one file per agent under docs/eval/ (see docs/eval/risk.md), so this
 * always does a full rewrite of *its own* file only and never clobbers another agent's eval.
 * Uses the same checkGrounding() as scripts/test-grounding.ts.
 *
 *   npx tsx scripts/eval-models.ts
 *
 * Costs money for the anthropic row if ANTHROPIC_API_KEY is set; gemini/groq/ollama are free
 * (gemini/groq up to their free-tier caps — see lib/agents/providers/*.ts for current limits).
 */
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { runAgent, type AgentProvider } from "../lib/agents/runner";
import { checkGrounding, allMetrics, type RealFact } from "../lib/agents/grounding";
import { RateLimitError } from "../lib/agents/providers/errors";
import type { Fundamentals } from "../lib/report/types";

const AGENT_PATH = path.join(__dirname, "../.claude/agents/analysis/valuation.md");
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
  factIdReal: boolean;
  valueMatch: boolean;
  labelMatch: boolean;
  retryCount: number;
  elapsedMs: number;
  nullCount: number;
  valuedCount: number;
  note: string;
  issueDetails: string[];
}

function skippedRow(provider: string, ticker: string, note: string): EvalRow {
  return { provider, model: "-", ticker, zod: false, factIdReal: false, valueMatch: false, labelMatch: false, retryCount: 0, elapsedMs: 0, nullCount: 0, valuedCount: 0, note, issueDetails: [] };
}

async function evalOne(prisma: PrismaClient, ticker: string, provider: AgentProvider): Promise<EvalRow> {
  const keyEnv = PROVIDER_KEY_ENV[provider];
  if (keyEnv && !process.env[keyEnv]) {
    return skippedRow(provider, ticker, `skipped: ${keyEnv} not set`);
  }

  try {
    const result = await runAgent(prisma, ticker, AGENT_PATH, "fundamentals", provider);
    if (!result.ok) {
      return { ...skippedRow(provider, ticker, `zod failed: ${(result.errors?.[0] ?? "").slice(0, 120)}`), model: result.backendModel, retryCount: result.retryCount, elapsedMs: result.elapsedMs };
    }

    const fundamentals = result.content as Fundamentals;
    const all = allMetrics(fundamentals);
    const valued = all.filter((m) => m.value !== null);
    const nullCount = all.length - valued.length;

    const factIds = [...new Set(valued.map((m) => m.factId).filter((id): id is string => id !== null))];
    const realFacts: RealFact[] = factIds.length
      ? await prisma.financialFact.findMany({ where: { id: { in: factIds } }, select: { id: true, metricName: true, value: true, unit: true } })
      : [];
    const grounding = checkGrounding(fundamentals, realFacts);
    const factIdReal = !grounding.issues.some((i) => i.reason === "unknown-factId" || i.reason === "missing-factId");
    const valueMatch = !grounding.issues.some((i) => i.reason === "value-mismatch");
    const labelMatch = !grounding.issues.some((i) => i.reason === "metricName-mismatch");

    return {
      provider,
      model: result.backendModel,
      ticker,
      zod: true,
      factIdReal,
      valueMatch,
      labelMatch,
      retryCount: result.retryCount,
      elapsedMs: result.elapsedMs,
      nullCount,
      valuedCount: valued.length,
      note: grounding.ok ? "" : `${grounding.issues.length} grounding issue(s), see appendix`,
      issueDetails: grounding.issues.map((i) => `[${i.reason}] ${i.metricName}: ${i.detail}`),
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
  const header = "| provider | model | zod | factId จริง | ค่าตรง | label ตรง | null/valued | retry | เวลา | note |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map(
    (r) =>
      `| ${r.provider} | ${r.model} | ${fmtBool(r.zod)} | ${fmtBool(r.factIdReal)} | ${fmtBool(r.valueMatch)} | ${fmtBool(r.labelMatch)} | ${r.nullCount}/${r.valuedCount} | ${r.retryCount} | ${(r.elapsedMs / 1000).toFixed(1)}s | ${r.note} |`,
  );
  return [header, sep, ...body].join("\n");
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const rowsByTicker: Record<string, EvalRow[]> = {};

  for (const ticker of TICKERS) {
    const factCount = await prisma.financialFact.count({ where: { ticker } });
    if (!factCount) {
      console.log(`skipping ${ticker}: no FinancialFact rows — run scripts/ingest.ts ${ticker} first`);
      continue;
    }
    rowsByTicker[ticker] = [];
    for (const provider of PROVIDERS) {
      process.stdout.write(`${provider} / ${ticker}... `);
      const row = await evalOne(prisma, ticker, provider);
      console.log(row.note || "ok");
      rowsByTicker[ticker].push(row);
    }
  }

  const lines: string[] = [];
  lines.push("# Model / provider evaluation — valuation agent");
  lines.push("");
  lines.push(
    "Generated by `scripts/eval-models.ts`. Each provider runs the same valuation agent (`.claude/agents/analysis/valuation.md`) against the same FinancialFact rows. Checks come from `lib/agents/grounding.ts` (also see `scripts/test-grounding.ts`): **factId จริง** = every cited factId exists in FinancialFact; **ค่าตรง** = cited value matches FinancialFact.value exactly; **label ตรง** = the metric's name plausibly matches FinancialFact.metricName (catches a real factId borrowed from a different metric)."
  );
  lines.push("");
  lines.push(
    "Note on reading factId/value/label together: checkGrounding stops at the first problem found per metric (missing/unknown factId → value-mismatch → metricName-mismatch, in that order). So a row with factId จริง=✗ can still show ค่าตรง=✓ and label ตรง=✓ — that means none of the *other* metrics had a value/label problem, not that the bad-factId metrics themselves passed those checks (they were never reached). See the appendix under each table for the actual per-metric issues."
  );
  lines.push("");

  for (const ticker of TICKERS) {
    if (!rowsByTicker[ticker]) continue;
    lines.push(`## ${ticker}`);
    lines.push("");
    if (ticker !== "MSFT") {
      lines.push(
        "**null/valued**: how many metrics the model included with `value:null` (correctly, when no fact supports it) vs. with a real value — the whole point of testing a sparse-coverage ticker like this one is to see which models are willing to say \"I don't have this\" instead of inventing a plausible-looking number."
      );
      lines.push("");
    }
    lines.push(table(rowsByTicker[ticker]));
    lines.push("");

    const withIssues = rowsByTicker[ticker].filter((r) => r.issueDetails.length > 0);
    if (withIssues.length) {
      lines.push("<details><summary>issue details</summary>");
      lines.push("");
      for (const r of withIssues) {
        lines.push(`**${r.provider} (${r.model})**:`);
        for (const d of r.issueDetails) lines.push(`- ${d}`);
        lines.push("");
      }
      lines.push("</details>");
      lines.push("");
    }
  }

  await fs.mkdir("docs/eval", { recursive: true });
  await fs.writeFile("docs/eval/valuation.md", lines.join("\n"));
  console.log("\nwrote docs/eval/valuation.md");

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
