/**
 * StockReport — โครงสร้าง report แบบ Fiscal.ai + IDS verdict
 * ทุก agent เขียนลง object นี้ แล้ว renderer อ่านไปทำ HTML
 */

import type { ExpectationGapResult } from '../data/expectation-gap';

export type Exchange = 'SEC' | 'HKEX' | 'SET';
export type ModelTier = 'TIER1_FABLE5' | 'TIER2_OPUS' | 'TIER3_SONNET' | 'NONE';
export type Unit = 'x' | '%' | 'currency' | 'count' | 'raw';

// ---------- 1. Meta ----------

export interface ReportMeta {
  ticker: string;
  companyName: string;
  exchange: Exchange;
  currency: string;          // 'HKD' | 'USD' | 'THB' | 'CNY'
  generatedAt: string;       // ISO
  dataAsOf: string;          // วันที่ของงบล่าสุด
  modelTier: ModelTier;
  themes: string[];          // manually set on Stock.themes — rendered as [[Theme - X]] wikilinks in the
                             // Obsidian export (see lib/report/obsidian-export.ts). No Theme Agent exists
                             // yet (that's a later phase); this is just a plain field you set yourself so
                             // the export/vault-organization side doesn't have to wait on it.
}

// ---------- 2. Price ----------

export interface PricePoint { date: string; close: number }

export interface PriceChart {
  current: number;
  change: number;
  changePct: number;
  periodLabel: string;       // 'past 5 years'
  cagr: number | null;
  series: PricePoint[];
}

// ---------- 3. Fundamentals ----------

export interface Metric {
  name: string;
  value: number | null;      // null -> render '—'
  unit: Unit;
  factId: string | null;     // Gate 1 บังคับ != null ถ้า value != null
}

export interface MetricGroup {
  label: string;
  metrics: Metric[];
}

export interface Fundamentals {
  profile: MetricGroup;
  margins: MetricGroup;
  returns: MetricGroup;
  valuationTTM: MetricGroup;
  valuationNTM: MetricGroup | null;
  financialHealth: MetricGroup;
  growth: MetricGroup;
  dividends: MetricGroup | null;
}

// ---------- 4/8/9. Bullets ----------

export interface BulletItem {
  title: string;
  body: string;
  example: string;                   // บังคับ — "For example, ..."
  supportingFactIds: string[];       // บังคับอย่างน้อย 1 — factId จริงจาก FinancialFact ที่ข้อความนี้อ้างอิง
}

// ---------- 5. Moat ----------

export type MoatType =
  | 'counter_positioning' | 'scale_economies' | 'switching_costs'
  | 'network_economies'   | 'brand'           | 'cornered_resource'
  | 'process_power'       | 'none';

export interface MoatItem {
  type: MoatType;
  title: string;
  body: string;
  strength: 'strong' | 'moderate' | 'weak';
  supportingFactIds: string[];       // บังคับอย่างน้อย 1 — factId จริงจาก FinancialFact ที่ใช้เป็นหลักฐาน (ตรงๆ หรือโดยอ้อมก็ได้ ดู moat.md)
}

// ---------- 5b. Factor Sensitivity (Phase 2 roadmap item) — same shape/grounding discipline as
// MoatItem (qualitative judgment, not a provable fact, but every number cited is still checked),
// just with a direction on top of magnitude. No factId equivalent exists for "is this factor
// actually relevant" the way it does for a cited number — that judgment call is inherent to this
// section, flagged in the agent's own output rather than hidden. ----------

export type MacroFactor =
  | 'interest_rates' | 'usd_strength' | 'oil_price'
  | 'china_demand'   | 'consumer_spending' | 'commodity_input_costs';

export interface FactorExposure {
  factor: MacroFactor;
  direction: 'positive' | 'negative';  // stock benefits (positive) or is hurt (negative) when the factor RISES
  weight: 'high' | 'medium' | 'low';
  title: string;
  body: string;
  supportingFactIds: string[];         // บังคับอย่างน้อย 1 — เหมือน MoatItem, ตรงหรือโดยอ้อมก็ได้
}

// ---------- 6/7. Charts ----------

export interface ChartSeries {
  name: string;
  values: (number | null)[];
  color?: string;
  totalChangePct?: number | null;
  cagr?: number | null;
}

export interface ChartBlock {
  id: 'revenue_opinc' | 'valuation_multiples' | 'eps_fcf';
  title: string;
  xLabels: string[];
  series: ChartSeries[];
}

// ---------- 10. Estimates ----------

export interface EstimateBlock {
  metric: 'revenue' | 'eps' | 'ebitda' | 'fcf';
  periods: string[];

  consensus: {
    mean: (number | null)[];
    high: (number | null)[];
    low: (number | null)[];
    stdDev: (number | null)[];
    numEstimates: (number | null)[];
    lowCoverage: boolean;          // true ถ้า numEstimates < 3 -> ห้ามใช้เป็น input หลัก
  } | null;

  own: {
    bear: (number | null)[];
    base: (number | null)[];
    bull: (number | null)[];
    method: string;
    assumptions: string[];
  } | null;

  actual: (number | null)[];
  beatMissPct: (number | null)[];
  divergencePct: number | null;    // own.base vs consensus.mean — เกิน ±15% ต้องอธิบาย
}

// ---------- 11. Insider ----------

export interface InsiderRow {
  name: string;
  title: string;
  date: string;
  shares: number;
  pctOwned: number;
  marketValue: number | null;
}

// ---------- 13. Verdict ----------

export type TriggerComparator = 'lt' | 'lte' | 'gt' | 'gte';

// Phase 2 roadmap item ("Invalidation Triggers") — killCriteria (prose) stays for the narrative;
// this is the measurable subset the agent can point at a real, currently-tracked FinancialFact
// metric for. Not every kill criterion has a clean metric behind it (e.g. "a new CEO reverses the
// buyback program" has none), so this doesn't replace killCriteria — it's a stricter, checkable
// companion. scripts/scorecard.ts evaluates these against the latest FinancialFact for the ticker
// to flag a trigger that's actually fired, not just a human re-reading the prose to notice.
export interface InvalidationTrigger {
  description: string;              // human-readable, e.g. "FCF turns negative"
  metricName: string;                // a real FinancialFact.metricName for this ticker — checked by checkInvalidationTriggers (lib/agents/grounding.ts)
  comparator: TriggerComparator;      // how the *latest* value of metricName compares to threshold when the trigger fires
  threshold: number;
}

export interface Verdict {
  decision: 'GO' | 'WAIT' | 'NO_GO';
  conviction: 1 | 2 | 3 | 4 | 5;
  thesis: string;
  killCriteria: string[];
  invalidationTriggers: InvalidationTrigger[];
  // Phase 4 ("Leading Indicator Agent") — same shape as InvalidationTrigger, opposite direction:
  // what would confirm moving WAIT -> GO, not what breaks the thesis. Required (>=1) when
  // decision === 'WAIT', enforced by VerdictSchema's refine (lib/report/schema.ts); empty for
  // GO/NO_GO, which have already decided.
  confirmationTriggers: InvalidationTrigger[];
  reviewDate: string;
}

// ---------- 13b. Synthesis (agent #4 "boss" — bulls+bears+verdict in one shot, since a real
// verdict has to weigh bulls against bears together, not be produced independently of them) ----------

// bulls/bears were plain string[] until a live eval showed why that's dangerous: an agent (groq)
// wrote citations *inline in the prose* ("... (cmt023y0j...)") with nothing to check them against
// — 4 of 5 citations turned out to point at the wrong fact or no fact at all, and it read as
// well-grounded on a skim specifically because the citation was there but unverifiable. ClaimItem
// forces the citation out into its own checkable field, same fix as BulletItem.supportingFactIds.
export interface ClaimItem {
  claim: string;
  supportingFactIds: string[];       // บังคับอย่างน้อย 1 — factId จริงจาก FinancialFact เท่านั้น ห้ามแทรก id ไว้ในข้อความ claim เอง
}

export interface Synthesis {
  bulls: ClaimItem[];    // บังคับ >=2
  bears: ClaimItem[];    // บังคับ >=2
  verdict: Verdict;
}

// ---------- root ----------

export interface StockReport {
  meta: ReportMeta;
  priceChart: PriceChart | null;
  businessSummary: ClaimItem[];       // บังคับ >=1
  fundamentals: Fundamentals;         // บังคับ
  recentDevelopments: BulletItem[];
  moat: MoatItem[];
  factorSensitivity: FactorExposure[];
  charts: ChartBlock[];
  growthDrivers: BulletItem[];
  riskFactors: BulletItem[];          // บังคับ >=1
  estimates: EstimateBlock[];
  insiders: InsiderRow[];
  bulls: ClaimItem[];                 // บังคับ >=2
  bears: ClaimItem[];                 // บังคับ >=2
  verdict: Verdict;                   // บังคับ
  expectationGap: ExpectationGapResult | null; // Phase 2 "Expectation Gap Model" — reverse DCF, computed by lib/data/expectation-gap.ts in the orchestrator (pure math, not agent output — no grounding check needed). Null when there isn't enough data to compute it (e.g. negative FCF, no achievable-growth reference).
}

// Re-exported so callers of this file don't also need to import from lib/data/expectation-gap.ts
// just to reference the result shape.
export type { ExpectationGapResult } from '../data/expectation-gap';

/** section ที่ Gate 5 (Completeness) บังคับต้องมี */
export const REQUIRED_SECTIONS = [
  'businessSummary', 'fundamentals', 'riskFactors', 'bulls', 'bears', 'verdict',
] as const;
