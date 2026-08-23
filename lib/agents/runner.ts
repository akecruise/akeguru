/**
 * Layer 3 — runs an analysis agent (a markdown file under .claude/agents/) against a ticker's
 * already-ingested FinancialFact rows, validates the JSON output against sectionSchemas (Gate 1:
 * every non-null Metric must cite a real factId), retries with the validation errors fed back on
 * failure, and saves a passing result as AnalysisOutput.
 *
 * Prisma client is passed in, not owned here — matches lib/refresh.ts's convention (callers build
 * their own client against whichever connection is appropriate for that context).
 */
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type { PrismaClient, Prisma } from "../../generated/prisma/client";
import { validateSection, sectionSchemas, type SectionName } from "../report/schema";
import { checkGrounding, checkBulletGrounding, checkMoatGrounding, checkFactorSensitivityGrounding, checkClaimGrounding, checkInvalidationTriggers, type RealFact } from "./grounding";
import { RateLimitError, FatalProviderError } from "./providers/errors";
import type { Fundamentals, BulletItem, MoatItem, FactorExposure, ClaimItem, Synthesis } from "../report/types";
import * as anthropicProvider from "./providers/anthropic";
import * as geminiProvider from "./providers/gemini";
import * as groqProvider from "./providers/groq";
import * as ollamaProvider from "./providers/ollama";
import * as xaiProvider from "./providers/xai";
import * as claudeCliProvider from "./providers/claude-cli";

// Exported: lib/agents/sentiment-runner.ts (Phase 3 "Xueqiu Layer 8") reuses the same provider
// call shape for post sentiment analysis, which doesn't fit runAgent()'s FinancialFact-grounding-
// specific retry loop below -- there's no numeric fact to check a sentiment classification against.
export const PROVIDERS = {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  groq: groqProvider,
  ollama: ollamaProvider,
  xai: xaiProvider,
  "claude-cli": claudeCliProvider,
} as const;
export type AgentProvider = keyof typeof PROVIDERS;

/** AGENT_PROVIDER picks which backend actually answers — same (systemPrompt, userPrompt) =>
 *  Promise<string> interface on all four, so this is the only place that needs to know which one
 *  is active. Defaults to anthropic (the paid, most capable path) when unset. */
export function resolveProvider(override?: AgentProvider): AgentProvider {
  const name = override ?? (process.env.AGENT_PROVIDER as AgentProvider | undefined) ?? "anthropic";
  if (!(name in PROVIDERS)) {
    throw new Error(`AGENT_PROVIDER "${name}" ไม่ถูกต้อง (ต้องเป็น ${Object.keys(PROVIDERS).join("|")})`);
  }
  if (name === "ollama") {
    // qwen3:8b (the local model this resolves to) has fabricated citations on every live eval run
    // to date — invented factIds on the valuation task (docs/eval/valuation.md, all 18 factIds on
    // MSFT) and again on synthesis (docs/eval/synthesis.md, section-header-shaped fake ids like
    // "moat001"/"fundamentals006" on both tickers). checkGrounding/checkBulletGrounding/
    // checkMoatGrounding/checkClaimGrounding catch it every time, so it's safe to use for
    // exercising the validation/retry machinery itself — just never trust its content.
    console.warn(
      '⚠️  AGENT_PROVIDER=ollama — ใช้ทดสอบโครงสร้าง (schema/retry/grounding-check) เท่านั้น ห้ามใช้กับ pipeline จริง: qwen3:8b แต่ง citation ปลอมทุกรอบที่เคยรัน (ดู docs/eval/valuation.md, docs/eval/synthesis.md)',
    );
  }
  return name;
}

// ModelTier is a fixed enum (TIER1_FABLE5/TIER2_OPUS/TIER3_SONNET/NONE) — it records the tier the
// *agent file* nominally asks for (from its "model:" frontmatter), not which provider/backend
// actually answered. Which real model ran is recorded in AnalysisOutput.generatedBy instead
// (e.g. "valuation (gemini/gemini-2.5-flash)") since that's a free-text field.
const AGENT_MODEL_TIER = {
  fable5: "TIER1_FABLE5" as const,
  opus: "TIER2_OPUS" as const,
  sonnet: "TIER3_SONNET" as const,
};
export type AgentModelKey = keyof typeof AGENT_MODEL_TIER;

const MAX_RETRIES = 2; // 1 initial attempt + up to 2 retries = 3 attempts total
const RATE_LIMIT_BACKOFF_MS = 5_000; // multiplied by (attempt + 1) — 5s, then 10s

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AgentFile {
  name: string;
  model: AgentModelKey;
  instructions: string;
}

export async function loadAgent(agentPath: string): Promise<AgentFile> {
  const raw = await fs.readFile(agentPath, "utf-8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`agent file ${agentPath}: ไม่มี frontmatter (---...---)`);
  const [, frontmatter, body] = match;

  const name = /^name:\s*(\S+)/m.exec(frontmatter)?.[1] ?? path.basename(agentPath, ".md");
  const modelKey = /^model:\s*(\S+)/m.exec(frontmatter)?.[1] as AgentModelKey | undefined;
  if (!modelKey || !(modelKey in AGENT_MODEL_TIER)) {
    throw new Error(`agent file ${agentPath}: model "${modelKey}" ไม่ถูกต้อง (ต้องเป็น ${Object.keys(AGENT_MODEL_TIER).join("|")})`);
  }
  return { name, model: modelKey, instructions: body.trim() };
}

export function tryParseJson(text: string): unknown {
  // strip a markdown fence if the model wrapped the JSON in one despite instructions not to
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*\n/, "")
    .replace(/\n```\s*$/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

export interface RunAgentResult {
  ok: boolean;
  section: SectionName;
  content: unknown;
  modelTier: (typeof AGENT_MODEL_TIER)[AgentModelKey];
  provider: AgentProvider;
  backendModel: string;
  retryCount: number;
  errors?: string[];
  analysisOutputId?: string;
  elapsedMs: number;
}

/**
 * Loads FinancialFact for `ticker`, deduped to the latest row per (metricName, period) — repeat
 * ingest runs on the same day otherwise leave several near-duplicate Yahoo snapshots (same
 * metricName+period, different rawSourceId/value as the live quote moved) that would waste tokens
 * and give the agent an ambiguous choice of factId for the "same" number.
 */
async function loadLatestFacts(prisma: PrismaClient, ticker: string) {
  const rows = await prisma.financialFact.findMany({
    where: { ticker },
    select: { id: true, metricName: true, value: true, unit: true, period: true, statement: true, extractedAt: true },
    orderBy: { extractedAt: "desc" },
  });
  const seen = new Set<string>();
  const deduped = [];
  for (const r of rows) {
    const key = `${r.metricName}|${r.period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped;
}

/**
 * Runs the grounding check that applies to `section` (Gate 2's checks, but per-agent and before
 * anything is saved, not post-hoc on an already-saved ResearchReport) and returns any issues as
 * feedback strings in the same shape validateSection() errors already use — so the retry loop
 * below can treat a hallucinated factId/number exactly like a schema failure. estimates/insiders/
 * charts/verdict have no supportingFactIds-bearing field, so there's nothing to check there.
 */
function groundingIssuesForSection(section: SectionName, data: unknown, realFacts: RealFact[]): string[] {
  switch (section) {
    case "fundamentals":
      return checkGrounding(data as Fundamentals, realFacts).issues.map((i) => `${i.metricName}: ${i.reason} — ${i.detail}`);
    case "riskFactors":
    case "growthDrivers":
    case "recentDevelopments":
      return checkBulletGrounding(data as BulletItem[], realFacts).issues.map((i) => `"${i.title}": ${i.reason} — ${i.detail}`);
    case "moat":
      return checkMoatGrounding(data as MoatItem[], realFacts).issues.map((i) => `"${i.title}": ${i.reason} — ${i.detail}`);
    case "factorSensitivity":
      return checkFactorSensitivityGrounding(data as FactorExposure[], realFacts).issues.map((i) => `"${i.title}": ${i.reason} — ${i.detail}`);
    case "businessSummary":
    case "bulls":
    case "bears":
      return checkClaimGrounding(data as ClaimItem[], realFacts).issues.map((i) => `"${i.title}": ${i.reason} — ${i.detail}`);
    case "synthesis": {
      const s = data as Synthesis;
      const claimIssues = [...checkClaimGrounding(s.bulls, realFacts).issues, ...checkClaimGrounding(s.bears, realFacts).issues];
      const triggerIssues = checkInvalidationTriggers(s.verdict.invalidationTriggers, realFacts).issues;
      return [
        ...claimIssues.map((i) => `"${i.title}": ${i.reason} — ${i.detail}`),
        ...triggerIssues.map((i) => `invalidationTrigger "${i.description}": ${i.reason} — ${i.detail}`),
      ];
    }
    default:
      return [];
  }
}

export async function runAgent(
  prisma: PrismaClient,
  ticker: string,
  agentPath: string,
  section: SectionName,
  providerOverride?: AgentProvider,
  extraContext?: string,
): Promise<RunAgentResult> {
  const startedAt = Date.now();
  const agent = await loadAgent(agentPath);
  const tier = AGENT_MODEL_TIER[agent.model];

  const providerName = resolveProvider(providerOverride);
  const provider = PROVIDERS[providerName];
  const backendModel = provider.MODEL_NAME;
  const backendLabel = `${providerName}/${backendModel}`;

  // Passed to every provider (only claude-cli.ts's --json-schema mechanism actually uses it — see
  // that file's header comment for why array-typed sections need special handling there).
  const jsonSchema = z.toJSONSchema(sectionSchemas[section] as z.ZodType) as Record<string, unknown>;

  const facts = await loadLatestFacts(prisma, ticker);
  if (!facts.length) {
    throw new Error(`ไม่มี FinancialFact สำหรับ ${ticker} — รัน scripts/ingest.ts ${ticker} ก่อน`);
  }

  const factsBlock = facts
    .map((f) => `- id=${f.id}  ${f.metricName} = ${f.value} ${f.unit}  (period=${f.period}${f.statement ? `, ${f.statement}` : ""})`)
    .join("\n");

  // extraContext: prior agent outputs (fundamentals/riskFactors/moat JSON) for a synthesis-style
  // agent that reasons over other agents' already-validated conclusions, not just raw facts. Kept
  // as a generic string param (not typed to the boss agent specifically) so any future agent that
  // needs upstream context can reuse this instead of runAgent growing a bespoke param per agent.
  const contextBlock = extraContext ? `\n\n${extraContext}` : "";

  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // lastErrors.length (not attempt === 0) picks the prompt shape: a transient provider failure
    // (caught below) resets lastErrors to [] before its retry, since there's no content problem to
    // describe back to the model — it should just see the same clean prompt again, not a
    // "your previous output failed validation" message about output that was never produced.
    const userMessage =
      lastErrors.length === 0
        ? `FinancialFact สำหรับ ${ticker} (${facts.length} รายการ):\n${factsBlock}${contextBlock}`
        : `FinancialFact สำหรับ ${ticker} (${facts.length} รายการ):\n${factsBlock}${contextBlock}\n\nOutput รอบก่อนไม่ผ่าน validation ด้วย error เหล่านี้ — แก้แล้วส่ง JSON ทั้งก้อนใหม่:\n${lastErrors.map((e) => `- ${e}`).join("\n")}`;

    let text: string;
    try {
      text = await provider.generate(agent.instructions, userMessage, jsonSchema);
    } catch (e) {
      // FatalProviderError (not logged in, no API key, CLI missing) — a retry can't fix a
      // misconfiguration, so fail fast instead of burning the remaining attempts on it.
      if (e instanceof FatalProviderError || attempt === MAX_RETRIES) throw e;
      // Everything else (timeout, non-zero exit, a malformed response envelope, RateLimitError) is
      // presumed transient. Back off on a rate limit specifically — every other transient case is
      // worth retrying immediately, no reason to wait.
      if (e instanceof RateLimitError) await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      lastErrors = [];
      continue;
    }

    const parsed = tryParseJson(text);
    if (parsed === undefined) {
      lastErrors = [`output ไม่ใช่ JSON ที่ parse ได้: ${text.slice(0, 200)}`];
      continue;
    }

    const result = validateSection(section, parsed);
    if (result.ok) {
      // Schema-valid isn't citation-clean (see lib/agents/grounding.ts's header comment and
      // docs/eval/*.md) — check grounding before saving, and feed any issue back into the same
      // retry loop schema failures already use, rather than saving a hallucinated citation and
      // only catching it later in Gate 2 after the whole report (and its API cost) is spent.
      const groundingIssues = groundingIssuesForSection(section, result.data, facts);
      if (groundingIssues.length === 0) {
        const saved = await prisma.analysisOutput.create({
          data: {
            ticker,
            section,
            content: parsed as Prisma.InputJsonValue,
            generatedBy: `${agent.name} (${backendLabel})`,
            modelTier: tier,
            gateStatus: "PENDING",
            retryCount: attempt,
          },
        });
        return {
          ok: true,
          section,
          content: parsed,
          modelTier: tier,
          provider: providerName,
          backendModel,
          retryCount: attempt,
          analysisOutputId: saved.id,
          elapsedMs: Date.now() - startedAt,
        };
      }
      lastErrors = groundingIssues;
      continue;
    }
    lastErrors = result.errors;
  }

  // total failure after MAX_RETRIES — not saved to AnalysisOutput: the content never passed
  // schema validation or grounding, so persisting it would put an unreliable citation (or a
  // non-conforming shape) in a column downstream code expects to already be validated and
  // trustworthy. The caller gets the errors to report instead.
  return {
    ok: false,
    section,
    content: null,
    modelTier: tier,
    provider: providerName,
    backendModel,
    retryCount: MAX_RETRIES,
    errors: lastErrors,
    elapsedMs: Date.now() - startedAt,
  };
}
