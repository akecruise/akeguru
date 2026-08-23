/**
 * Shared extraContext builders for agents that need more than raw FinancialFact rows (see
 * runAgent's extraContext param in lib/agents/runner.ts). One builder per kind of upstream
 * context; each agent that needs one imports only the builder(s) it needs.
 */
import type { PrismaClient } from "../../generated/prisma/client";
import { runAgent, type AgentProvider } from "./runner";
import type { SectionName } from "../report/schema";

/**
 * business.md's input — Stock.description/sector/industry (the old MVP's cached Yahoo
 * longBusinessSummary, see prisma/schema.prisma's Stock model). Not every ticker has a Stock row
 * (e.g. any ticker outside the old MVP's curated universe) — business.md's rule #3 requires an
 * honest "no description available" fallback rather than guessing, so this always returns
 * *something* the agent can act on instead of an empty/missing block.
 */
export async function buildCompanyProfileContext(prisma: PrismaClient, ticker: string): Promise<string> {
  const stock = await prisma.stock.findUnique({
    where: { ticker },
    select: { name: true, sector: true, industry: true, description: true },
  });
  if (!stock || !stock.description) {
    return "[companyProfile]\nไม่มีข้อมูล description สำหรับ ticker นี้ในระบบ (ไม่มี Stock row หรือไม่มี description ที่เก็บไว้)";
  }
  return [
    "[companyProfile]",
    `name: ${stock.name}`,
    stock.sector ? `sector: ${stock.sector}` : null,
    stock.industry ? `industry: ${stock.industry}` : null,
    `description: ${stock.description}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * synthesis.md's input — the already-validated fundamentals/riskFactors/moat output from the
 * earlier agents in the pipeline, plus today's date (for verdict.reviewDate's +90-day floor).
 * Callers pass whatever content they already have in hand (fresh from the same pipeline run, or
 * fetched from AnalysisOutput — see scripts/eval-synthesis.ts) rather than this function owning
 * how that content was obtained.
 */
export function buildSynthesisContext(fundamentals: unknown, riskFactors: unknown, moat: unknown, todayIso: string): string {
  return [
    "--- ผลวิเคราะห์จาก agent อื่นๆ ที่ทำไปแล้ว (ใช้ประกอบการตัดสินใจ ห้ามมองข้าม หรือขัดแย้งโดยไม่มีเหตุผล) ---",
    "",
    "[fundamentals]",
    JSON.stringify(fundamentals),
    "",
    "[riskFactors]",
    JSON.stringify(riskFactors),
    "",
    "[moat]",
    JSON.stringify(moat),
    "",
    `วันนี้คือ ${todayIso} (ใช้คำนวณ verdict.reviewDate)`,
  ].join("\n");
}

/**
 * Latest AnalysisOutput row for (ticker, section), or generate one fresh (always via gemini,
 * regardless of what provider the caller is testing — this is upstream *context* for synthesis,
 * not the thing under test, so it should stay constant/cheap rather than vary with whatever
 * provider a synthesis test run is targeting) if none exists yet. Shared by
 * scripts/eval-synthesis.ts (sweeps all providers) and scripts/test-synthesis-agent.ts
 * (single-ticker smoke test, matching every other agent's test-*-agent.ts).
 */
export async function getOrGenerateSectionOutput(
  prisma: PrismaClient,
  ticker: string,
  section: SectionName & ("fundamentals" | "riskFactors" | "moat"),
  agentPath: string,
): Promise<unknown> {
  const latest = await prisma.analysisOutput.findFirst({
    where: { ticker, section },
    orderBy: { createdAt: "desc" },
  });
  if (latest) return latest.content;

  const fallbackProvider: AgentProvider = "gemini";
  const result = await runAgent(prisma, ticker, agentPath, section, fallbackProvider);
  if (!result.ok) throw new Error(`failed to generate ${section} for ${ticker}: ${(result.errors ?? []).join("; ")}`);
  return result.content;
}
