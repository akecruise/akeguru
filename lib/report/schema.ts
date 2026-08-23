/**
 * zod validator ของ StockReport
 * ใช้ 2 จุด:
 *   1. ตรวจ output ของแต่ละ agent (sectionSchemas)
 *   2. ตรวจ report ทั้งก้อนก่อนเขียนลง DeepReport.payload
 */

import { z } from 'zod';

export const ExchangeSchema = z.enum(['SEC', 'HKEX', 'SET']);
export const ModelTierSchema = z.enum(['TIER1_FABLE5', 'TIER2_OPUS', 'TIER3_SONNET', 'NONE']);
export const UnitSchema = z.enum(['x', '%', 'currency', 'count', 'raw']);

// ---------- 1 ----------
export const ReportMetaSchema = z.object({
  ticker: z.string().min(1),
  companyName: z.string().min(1),
  exchange: ExchangeSchema,
  currency: z.string().length(3),
  generatedAt: z.string(),
  dataAsOf: z.string(),
  modelTier: ModelTierSchema,
  themes: z.array(z.string()),
});

// ---------- 2 ----------
export const PriceChartSchema = z.object({
  current: z.number(),
  change: z.number(),
  changePct: z.number(),
  periodLabel: z.string(),
  cagr: z.number().nullable(),
  series: z.array(z.object({ date: z.string(), close: z.number() })),
});

// ---------- 3 ----------
export const MetricSchema = z.object({
  name: z.string().min(1),
  value: z.number().nullable(),
  unit: UnitSchema,
  factId: z.string().nullable(),
}).refine(
  m => m.value === null || m.factId !== null,
  { message: 'Gate 1: metric ที่มีค่า ต้องมี factId' }
);

export const MetricGroupSchema = z.object({
  label: z.string().min(1),
  metrics: z.array(MetricSchema),
});

export const FundamentalsSchema = z.object({
  profile: MetricGroupSchema,
  margins: MetricGroupSchema,
  returns: MetricGroupSchema,
  valuationTTM: MetricGroupSchema,
  valuationNTM: MetricGroupSchema.nullable(),
  financialHealth: MetricGroupSchema,
  growth: MetricGroupSchema,
  dividends: MetricGroupSchema.nullable(),
});

// ---------- 4/8/9 ----------
export const BulletItemSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(10),
  example: z.string().min(10),                    // บังคับมีตัวอย่างรูปธรรม
  supportingFactIds: z.array(z.string()).min(1),  // บังคับอ้าง fact จริงอย่างน้อย 1 ตัว — ใช้กับ checkBulletGrounding()
});

// ---------- 5 ----------
export const MoatTypeSchema = z.enum([
  'counter_positioning', 'scale_economies', 'switching_costs',
  'network_economies', 'brand', 'cornered_resource', 'process_power', 'none',
]);

export const MoatItemSchema = z.object({
  type: MoatTypeSchema,
  title: z.string().min(1),
  body: z.string().min(10),
  strength: z.enum(['strong', 'moderate', 'weak']),
  supportingFactIds: z.array(z.string()).min(1),  // บังคับอ้าง fact จริงอย่างน้อย 1 ตัว — ใช้กับ checkMoatGrounding()
});

// ---------- 5b ----------
export const MacroFactorSchema = z.enum([
  'interest_rates', 'usd_strength', 'oil_price',
  'china_demand', 'consumer_spending', 'commodity_input_costs',
]);

export const FactorExposureSchema = z.object({
  factor: MacroFactorSchema,
  direction: z.enum(['positive', 'negative']),
  weight: z.enum(['high', 'medium', 'low']),
  title: z.string().min(1),
  body: z.string().min(10),
  supportingFactIds: z.array(z.string()).min(1),  // บังคับอ้าง fact จริงอย่างน้อย 1 ตัว — ใช้กับ checkFactorSensitivityGrounding()
});

// ---------- 6/7 ----------
export const ChartBlockSchema = z.object({
  id: z.enum(['revenue_opinc', 'valuation_multiples', 'eps_fcf']),
  title: z.string(),
  xLabels: z.array(z.string()),
  series: z.array(z.object({
    name: z.string(),
    values: z.array(z.number().nullable()),
    color: z.string().optional(),
    totalChangePct: z.number().nullable().optional(),
    cagr: z.number().nullable().optional(),
  })),
}).refine(
  c => c.series.every(s => s.values.length === c.xLabels.length),
  { message: 'series.values ต้องยาวเท่ากับ xLabels' }
);

// ---------- 10 ----------
export const EstimateBlockSchema = z.object({
  metric: z.enum(['revenue', 'eps', 'ebitda', 'fcf']),
  periods: z.array(z.string()),
  consensus: z.object({
    mean: z.array(z.number().nullable()),
    high: z.array(z.number().nullable()),
    low: z.array(z.number().nullable()),
    stdDev: z.array(z.number().nullable()),
    numEstimates: z.array(z.number().nullable()),
    lowCoverage: z.boolean(),
  }).nullable(),
  own: z.object({
    bear: z.array(z.number().nullable()),
    base: z.array(z.number().nullable()),
    bull: z.array(z.number().nullable()),
    method: z.string().min(10),
    assumptions: z.array(z.string()).min(1),
  }).nullable(),
  actual: z.array(z.number().nullable()),
  beatMissPct: z.array(z.number().nullable()),
  divergencePct: z.number().nullable(),
}).refine(
  e => e.consensus !== null || e.own !== null,
  { message: 'ต้องมี consensus หรือ own อย่างน้อยหนึ่ง' }
);

// ---------- 11 ----------
export const InsiderRowSchema = z.object({
  name: z.string(),
  title: z.string(),
  date: z.string(),
  shares: z.number(),
  pctOwned: z.number(),
  marketValue: z.number().nullable(),
});

// ---------- 13 ----------
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// Phase 2 ("Invalidation Triggers"): the measurable subset of killCriteria — a real
// FinancialFact.metricName (checked by checkInvalidationTriggers, lib/agents/grounding.ts) plus a
// comparator/threshold scripts/scorecard.ts can actually evaluate against the latest fact, instead
// of a human re-reading killCriteria's prose to notice a thesis broke.
export const InvalidationTriggerSchema = z.object({
  description: z.string().min(10),
  metricName: z.string().min(1),
  comparator: z.enum(['lt', 'lte', 'gt', 'gte']),
  threshold: z.number(),
});

export const VerdictSchema = z.object({
  decision: z.enum(['GO', 'WAIT', 'NO_GO']),
  conviction: z.number().int().min(1).max(5),
  thesis: z.string().min(20),
  killCriteria: z.array(z.string()).min(1),   // ต้องบอกได้ว่าอะไรทำให้เปลี่ยนใจ
  invalidationTriggers: z.array(InvalidationTriggerSchema).min(1),
  reviewDate: z.string(),
}).refine(
  v => {
    const review = new Date(`${v.reviewDate}T00:00:00Z`);
    if (Number.isNaN(review.getTime())) return false;
    return review.getTime() - Date.now() >= NINETY_DAYS_MS;
  },
  // hard-enforced, not just a prompt instruction: a live eval (docs/eval/synthesis.md) showed both
  // ollama runs return today's date verbatim despite the prompt asking for +90 days
  { message: 'Gate: reviewDate ต้องเป็นวันที่ตั้งแต่วันนี้ + 90 วันขึ้นไป (ISO date, YYYY-MM-DD)' }
);

// ---------- 13b ----------
// bulls+bears+verdict as one output — the "boss"/synthesis agent's verdict has to weigh bulls
// against bears, so all three are produced together in one call rather than as 3 independent
// section agents that never see each other's output.
//
// bulls/bears used to be plain string[] — changed after a live eval showed an agent (groq) writing
// citations inline in the prose text ("... (cmt023y0j...)") with no field to check them against: 4
// of its 5 citations turned out wrong (borrowed factId, fabricated factId, or a real factId with a
// value roughly half the real one) despite looking well-grounded on a skim. ClaimItem forces the
// citation into its own array, same fix as BulletItem.supportingFactIds, and the refine below
// blocks the inline-citation escape hatch directly: an unverifiable citation in prose is worse than
// no citation, because it reads as grounded when it isn't.
const CUID_PATTERN = /\bc[a-z0-9]{24}\b/;

export const ClaimItemSchema = z.object({
  claim: z.string().min(10),
  supportingFactIds: z.array(z.string()).min(1),  // บังคับอ้าง fact จริงอย่างน้อย 1 ตัว — ใช้กับ checkClaimGrounding()
}).refine(
  c => !CUID_PATTERN.test(c.claim),
  { message: 'Gate: ห้ามแทรก factId (เช่น cuid) ไว้ในข้อความ claim เอง — citation ที่ตรวจไม่ได้ = อันตรายกว่าไม่มี citation ใส่ id ใน supportingFactIds แทน' }
);

export const SynthesisSchema = z.object({
  bulls: z.array(ClaimItemSchema).min(2),
  bears: z.array(ClaimItemSchema).min(2),
  verdict: VerdictSchema,
});

// ---------- 14 ----------
// Phase 2 "Expectation Gap Model" — computed by lib/data/expectation-gap.ts in the orchestrator
// (pure math, not agent output), so this only needs shape validation, no grounding check.
export const ExpectationGapSchema = z.object({
  requiredReturn: z.number(),
  impliedGrowthRate: z.number(),
  achievableGrowthRate: z.number(),
  gapPct: z.number(),
  classification: z.enum(['priced-for-perfection', 'reasonable', 'undervalued-expectations', 'unreliable']),
});

// ---------- root ----------
export const StockReportSchema = z.object({
  meta: ReportMetaSchema,
  priceChart: PriceChartSchema.nullable(),
  businessSummary: z.array(ClaimItemSchema).min(1),
  fundamentals: FundamentalsSchema,
  recentDevelopments: z.array(BulletItemSchema).default([]),
  moat: z.array(MoatItemSchema).default([]),
  factorSensitivity: z.array(FactorExposureSchema).default([]),
  charts: z.array(ChartBlockSchema).default([]),
  growthDrivers: z.array(BulletItemSchema).default([]),
  riskFactors: z.array(BulletItemSchema).min(1),
  estimates: z.array(EstimateBlockSchema).default([]),
  insiders: z.array(InsiderRowSchema).default([]),
  bulls: z.array(ClaimItemSchema).min(2),
  bears: z.array(ClaimItemSchema).min(2),
  verdict: VerdictSchema,
  expectationGap: ExpectationGapSchema.nullable(),
});

/** schema แยกรายsection — ใช้ตรวจ output ของ agent แต่ละตัว */
export const sectionSchemas = {
  businessSummary:    z.array(ClaimItemSchema).min(1),
  fundamentals:       FundamentalsSchema,
  recentDevelopments: z.array(BulletItemSchema),
  moat:               z.array(MoatItemSchema),
  factorSensitivity:  z.array(FactorExposureSchema),
  charts:             z.array(ChartBlockSchema),
  growthDrivers:      z.array(BulletItemSchema),
  riskFactors:        z.array(BulletItemSchema).min(1),
  estimates:          z.array(EstimateBlockSchema),
  insiders:           z.array(InsiderRowSchema),
  bulls:              z.array(ClaimItemSchema).min(2),
  bears:              z.array(ClaimItemSchema).min(2),
  verdict:            VerdictSchema,
  synthesis:          SynthesisSchema,
} as const;

export type SectionName = keyof typeof sectionSchemas;

/** ตรวจ output agent — คืน error ที่อ่านง่ายเพื่อส่งกลับเข้า feedback loop */
export function validateSection(section: SectionName, data: unknown) {
  const r = sectionSchemas[section].safeParse(data);
  if (r.success) return { ok: true as const, data: r.data };
  return {
    ok: false as const,
    errors: r.error.issues.map(i => `${i.path.join('.') || section}: ${i.message}`),
  };
}

export function validateReport(data: unknown) {
  const r = StockReportSchema.safeParse(data);
  if (r.success) return { ok: true as const, data: r.data };
  return {
    ok: false as const,
    errors: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  };
}
