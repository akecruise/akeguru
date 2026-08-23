/**
 * StockReport — โครงสร้าง report แบบ Fiscal.ai + IDS verdict
 * ทุก agent เขียนลง object นี้ แล้ว renderer อ่านไปทำ HTML
 */

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

export interface Verdict {
  decision: 'GO' | 'WAIT' | 'NO_GO';
  conviction: 1 | 2 | 3 | 4 | 5;
  thesis: string;
  killCriteria: string[];
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
  charts: ChartBlock[];
  growthDrivers: BulletItem[];
  riskFactors: BulletItem[];          // บังคับ >=1
  estimates: EstimateBlock[];
  insiders: InsiderRow[];
  bulls: ClaimItem[];                 // บังคับ >=2
  bears: ClaimItem[];                 // บังคับ >=2
  verdict: Verdict;                   // บังคับ
}

/** section ที่ Gate 5 (Completeness) บังคับต้องมี */
export const REQUIRED_SECTIONS = [
  'businessSummary', 'fundamentals', 'riskFactors', 'bulls', 'bears', 'verdict',
] as const;
