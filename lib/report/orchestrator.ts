/**
 * Runs every agent for one ticker, assembles a full StockReport, and validates it — the "put it
 * all together" step. Sections not yet built (priceChart, charts, recentDevelopments, insiders)
 * are left at their honest empty/null default rather than faked; StockReportSchema/REQUIRED_SECTIONS
 * only requires businessSummary/fundamentals/riskFactors/bulls/bears/verdict, so a report missing
 * only those optional sections still validates.
 *
 * Order matters: valuation/risk/moat run first (independent of each other), then business/growth
 * (independent of those three), then estimates (pure function, no LLM — see lib/report/estimates.ts),
 * then synthesis last, since it specifically needs fundamentals/riskFactors/moat as context (see
 * lib/agents/context.ts's buildSynthesisContext) to weigh bulls against bears.
 *
 * Does NOT run the Gate 1-6 / QualityGateLog pipeline referenced in prisma/schema.prisma
 * (gateNumber 1-6, gateName 'fact'|'consistency'|...|'nena') — that's a separate step against the
 * already-saved ResearchReport (lib/gates's runGates(), called from scripts/run-report.ts after
 * the row is created), not part of assembling the report itself.
 */
import path from "path";
import type { PrismaClient } from "../../generated/prisma/client";
import { runAgent, resolveProvider, type AgentProvider } from "../agents/runner";
import { buildCompanyProfileContext, buildSynthesisContext } from "../agents/context";
import { buildConsensusEstimates } from "./estimates";
import { validateReport, type SectionName } from "./schema";
import { detectExchange } from "../data/input-sources/router";
import { computeExpectationGap, computeNormalizedFcf, computeRevenueCagr } from "../data/expectation-gap";
import type { StockReport, Fundamentals, BulletItem, MoatItem, FactorExposure, ClaimItem, Synthesis, ModelTier } from "./types";

/**
 * runAgent only returns {ok:false} on a zod-validation failure — a raw provider exception (network
 * error, malformed response, rate limit not wrapped as RateLimitError, etc.) propagates straight
 * out uncaught (this is the existing behavior every test-*-agent.ts script relies on: let main()
 * catch it and exit 1). That's fine for a single-agent script; it's wrong here, where 6 agent calls
 * chain in one run — one provider hiccup on agent #1 would crash the whole pipeline instead of
 * being recorded as a failed step like a zod failure already is. Found live: groq returned a 400
 * "Failed to generate JSON" on the very first call during smoke-testing this file.
 */
async function safeRunAgent(
  prisma: PrismaClient,
  ticker: string,
  agentPath: string,
  section: SectionName,
  providerOverride?: AgentProvider,
  extraContext?: string,
): Promise<Awaited<ReturnType<typeof runAgent>>> {
  const startedAt = Date.now();
  try {
    return await runAgent(prisma, ticker, agentPath, section, providerOverride, extraContext);
  } catch (e) {
    return {
      ok: false,
      section,
      content: null,
      modelTier: "TIER2_OPUS", // placeholder — every agent in this suite is opus-tier today; never
      // actually consumed on this path since a failed required agent short-circuits before
      // report.meta is built, and an optional agent's modelTier is never read on failure either
      provider: resolveProvider(providerOverride),
      backendModel: "(request failed before a response)",
      retryCount: 0,
      errors: [(e as Error).message],
      elapsedMs: Date.now() - startedAt,
    };
  }
}

const AGENTS_DIR = path.join(__dirname, "../../.claude/agents/analysis");
const AGENT_PATHS = {
  valuation: path.join(AGENTS_DIR, "valuation.md"),
  risk: path.join(AGENTS_DIR, "risk.md"),
  moat: path.join(AGENTS_DIR, "moat.md"),
  factorSensitivity: path.join(AGENTS_DIR, "factor-sensitivity.md"),
  business: path.join(AGENTS_DIR, "business.md"),
  growth: path.join(AGENTS_DIR, "growth.md"),
  synthesis: path.join(AGENTS_DIR, "synthesis.md"),
} as const;

interface AgentStepResult {
  agent: keyof typeof AGENT_PATHS;
  ok: boolean;
  provider: string;
  model: string;
  retryCount: number;
  elapsedMs: number;
  errors?: string[];
}

export interface RunFullReportResult {
  ticker: string;
  report: StockReport | null;
  validation: ReturnType<typeof validateReport>;
  steps: AgentStepResult[];
  totalElapsedMs: number;
}

const CURRENCY_BY_EXCHANGE: Record<string, string> = { SEC: "USD", HKEX: "HKD", SET: "THB" };

export async function runFullReport(
  prisma: PrismaClient,
  ticker: string,
  providerOverride?: AgentProvider,
): Promise<RunFullReportResult> {
  const startedAt = Date.now();
  const steps: AgentStepResult[] = [];
  const todayIso = new Date().toISOString().slice(0, 10);

  function record(agent: keyof typeof AGENT_PATHS, r: Awaited<ReturnType<typeof runAgent>>): void {
    steps.push({
      agent,
      ok: r.ok,
      provider: r.provider,
      model: r.backendModel,
      retryCount: r.retryCount,
      elapsedMs: r.elapsedMs,
      errors: r.errors,
    });
  }

  // Independent of each other and of business/growth — run first.
  const valuationResult = await safeRunAgent(prisma, ticker, AGENT_PATHS.valuation, "fundamentals", providerOverride);
  record("valuation", valuationResult);
  const riskResult = await safeRunAgent(prisma, ticker, AGENT_PATHS.risk, "riskFactors", providerOverride);
  record("risk", riskResult);
  const moatResult = await safeRunAgent(prisma, ticker, AGENT_PATHS.moat, "moat", providerOverride);
  record("moat", moatResult);
  const factorSensitivityResult = await safeRunAgent(prisma, ticker, AGENT_PATHS.factorSensitivity, "factorSensitivity", providerOverride);
  record("factorSensitivity", factorSensitivityResult);

  const companyProfileContext = await buildCompanyProfileContext(prisma, ticker);
  const businessResult = await safeRunAgent(prisma, ticker, AGENT_PATHS.business, "businessSummary", providerOverride, companyProfileContext);
  record("business", businessResult);
  const growthResult = await safeRunAgent(prisma, ticker, AGENT_PATHS.growth, "growthDrivers", providerOverride);
  record("growth", growthResult);

  // A required section (businessSummary/fundamentals/riskFactors) failed — no point continuing to
  // synthesis, which needs fundamentals/riskFactors/moat as context, or assembling a report that
  // validateReport will reject anyway. Return early with what's known.
  if (!valuationResult.ok || !riskResult.ok || !businessResult.ok) {
    return {
      ticker,
      report: null,
      validation: { ok: false, errors: ["one or more required-section agents failed — see steps[].errors"] },
      steps,
      totalElapsedMs: Date.now() - startedAt,
    };
  }

  // Pure math (see lib/data/expectation-gap.ts), computed before synthesis so its result can be
  // handed to that agent as context — the reverse-DCF read ("is this priced for more growth than
  // looks achievable") is exactly the kind of thing that should inform bulls/bears/thesis/
  // invalidationTriggers, not sit unused alongside them.
  const exchange = detectExchange(ticker);
  const expectationGapStock = await prisma.stock.findUnique({
    where: { ticker },
    select: { beta: true, marketCap: true, estRevenueGrowth: true },
  });
  const expectationGapFacts = await prisma.financialFact.findMany({
    where: {
      ticker,
      metricName: {
        in: ["NetCashProvidedByUsedInOperatingActivities", "PaymentsToAcquirePropertyPlantAndEquipment", "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"],
      },
    },
    select: { metricName: true, value: true, period: true },
  });
  const normalizedFcf = computeNormalizedFcf(expectationGapFacts);
  const revenueCagr = computeRevenueCagr(expectationGapFacts);
  const achievableGrowthRate =
    expectationGapStock?.estRevenueGrowth != null && revenueCagr != null
      ? (expectationGapStock.estRevenueGrowth + revenueCagr) / 2
      : (expectationGapStock?.estRevenueGrowth ?? revenueCagr);

  const expectationGap =
    normalizedFcf != null && achievableGrowthRate != null && expectationGapStock?.beta != null && expectationGapStock?.marketCap != null
      ? computeExpectationGap({
          marketCap: expectationGapStock.marketCap,
          beta: expectationGapStock.beta,
          currency: (CURRENCY_BY_EXCHANGE[exchange] ?? "USD") as "USD" | "THB" | "HKD",
          normalizedFcf,
          achievableGrowthRate,
        })
      : null;

  const synthesisContext =
    buildSynthesisContext(valuationResult.content, riskResult.content, moatResult.ok ? moatResult.content : [], todayIso) +
    `\n\n[expectationGap] (reverse DCF -- pre-computed, ไม่ใช่ agent output, ไม่ต้องมี factId แต่ควรเอาไปใช้ประกอบ thesis/killCriteria/invalidationTriggers ถ้ามีนัยสำคัญ)\n` +
    (expectationGap
      ? JSON.stringify(expectationGap)
      : "null (ข้อมูลไม่พอคำนวณ เช่น FCF ติดลบ หรือไม่มี estimate การเติบโต -- ไม่ต้องพูดถึงในรายงาน)") +
    `\n\n[factorSensitivity] (macro exposure ที่ agent ก่อนหน้าระบุไว้แล้ว -- เอาไปใช้ประกอบ bulls/bears/thesis ถ้ามีนัยสำคัญ)\n` +
    JSON.stringify(factorSensitivityResult.ok ? factorSensitivityResult.content : []);
  const synthesisResult = await safeRunAgent(prisma, ticker, AGENT_PATHS.synthesis, "synthesis", providerOverride, synthesisContext);
  record("synthesis", synthesisResult);

  if (!synthesisResult.ok) {
    return {
      ticker,
      report: null,
      validation: { ok: false, errors: ["synthesis agent failed — see steps[].errors"] },
      steps,
      totalElapsedMs: Date.now() - startedAt,
    };
  }

  // Pure function, no LLM (see lib/report/estimates.ts) — pull the consensus facts ingest.ts
  // already wrote via mapYahooEarningsTrendFacts.
  const consensusFacts = await prisma.financialFact.findMany({
    where: { ticker, OR: [{ metricName: { startsWith: "Revenue Estimate" } }, { metricName: { startsWith: "EPS Estimate" } }] },
    select: { metricName: true, value: true, period: true },
  });
  const estimates = buildConsensusEstimates(consensusFacts);

  const stock = await prisma.stock.findUnique({ where: { ticker }, select: { name: true, currency: true, themes: true } });

  const synthesis = synthesisResult.content as Synthesis;
  const report: StockReport = {
    meta: {
      ticker,
      companyName: stock?.name ?? ticker,
      exchange,
      currency: stock?.currency ?? CURRENCY_BY_EXCHANGE[exchange] ?? "USD",
      generatedAt: new Date().toISOString(),
      dataAsOf: todayIso,
      modelTier: valuationResult.modelTier as ModelTier,
      themes: stock?.themes ?? [],
    },
    priceChart: null, // not built yet
    businessSummary: businessResult.content as ClaimItem[],
    fundamentals: valuationResult.content as Fundamentals,
    recentDevelopments: [], // not built yet
    moat: moatResult.ok ? (moatResult.content as MoatItem[]) : [],
    factorSensitivity: factorSensitivityResult.ok ? (factorSensitivityResult.content as FactorExposure[]) : [],
    charts: [], // not built yet
    growthDrivers: growthResult.ok ? (growthResult.content as BulletItem[]) : [],
    riskFactors: riskResult.content as BulletItem[],
    estimates,
    insiders: [], // not built yet
    bulls: synthesis.bulls,
    bears: synthesis.bears,
    verdict: synthesis.verdict,
    expectationGap,
  };

  const validation = validateReport(report);

  return {
    ticker,
    report: validation.ok ? report : null,
    validation,
    steps,
    totalElapsedMs: Date.now() - startedAt,
  };
}
