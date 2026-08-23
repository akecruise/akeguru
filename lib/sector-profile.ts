/**
 * sector-profile.ts — GICS Sector-Aware Metric Configuration for akeguru
 *
 * ปัญหาที่แก้:
 *  1. SMT case: negative P/E ถูกตีความเป็น valuation signal ทั้งที่เป็น artifact
 *  2. ใช้ P/E วัดแบงก์/REIT → ข้อสรุปเพี้ยน
 *  3. IBD50-style screen (EPS growth 25%) คัด Utilities/Staples ตกหมดโดยไม่ตั้งใจ
 *
 * วิธีใช้:
 *  - valuation agent: inject `buildValuationGuidance(sector)` เข้า prompt
 *  - gate layer: `validateMetricUsage(sector, metricsUsed)` เป็น hard check
 *  - screener (stocklens): `getScreenerAdjustment(sector)` ปรับ/ยกเว้นเกณฑ์
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export const GicsSectorSchema = z.enum([
  "information_technology",
  "health_care",
  "financials",
  "consumer_discretionary",
  "consumer_staples",
  "communication_services",
  "industrials",
  "energy",
  "materials",
  "real_estate",
  "utilities",
]);
export type GicsSector = z.infer<typeof GicsSectorSchema>;

/** เศรษฐกิจของ sector — ใช้โดย Regime layer (Phase 3) ด้วย */
export type CyclicalityType = "secular_growth" | "cyclical" | "defensive" | "rate_sensitive";

export interface MetricDef {
  /** id ที่ใช้อ้างใน FinancialFact / รายงาน เช่น "pe", "ev_ebitda", "ffo" */
  id: string;
  label: string;
  /** คำอธิบายสั้นสำหรับ inject เข้า agent prompt */
  guidance?: string;
}

export interface SectorProfile {
  sector: GicsSector;
  displayName: string;
  cyclicality: CyclicalityType;

  /** valuation metrics หลัก — agent ต้องใช้อย่างน้อย 1 ตัวจากกลุ่มนี้ */
  primaryValuation: MetricDef[];
  /** valuation metrics เสริม */
  secondaryValuation: MetricDef[];
  /**
   * metrics ต้องห้าม — ถ้า agent ใช้ = gate fail
   * เช่น EV/EBITDA กับ financials, EPS-based P/E กับ REIT
   */
  forbiddenMetrics: { id: string; reason: string }[];

  /** operational KPIs เฉพาะ sector ที่ moat/growthDrivers agent ควรตามหา */
  keyOperationalMetrics: MetricDef[];

  /**
   * กับดักการตีความที่ agent ต้องรู้ก่อนสรุป
   * (นี่คือชั้นที่กันเคส SMT โดยตรง)
   */
  interpretationTraps: string[];

  /** การปรับเกณฑ์ screener สไตล์ IBD/Lynch */
  screenerAdjustment: {
    mode: "standard" | "relaxed" | "exclude";
    /** เกณฑ์ EPS growth ขั้นต่ำ (%) — null = ไม่ใช้เกณฑ์นี้กับ sector นี้ */
    minEpsGrowthPct: number | null;
    notes: string;
  };

  /** macro factors ที่ sector นี้ sensitive — ป้อนเข้า Factor Sensitivity Agent (Phase 2) */
  macroSensitivities: string[];
}

// ─────────────────────────────────────────────────────────────
// Profiles: 11 GICS Sectors
// ─────────────────────────────────────────────────────────────

export const SECTOR_PROFILES: Record<GicsSector, SectorProfile> = {
  information_technology: {
    sector: "information_technology",
    displayName: "Information Technology",
    cyclicality: "secular_growth",
    primaryValuation: [
      { id: "ev_sales", label: "EV/Sales", guidance: "ใช้กับ SaaS/บริษัทยังไม่กำไรเต็มที่" },
      { id: "peg", label: "PEG", guidance: "P/E ต้องเทียบ growth เสมอ อย่าใช้ P/E เดี่ยวๆ" },
      { id: "fcf_yield", label: "FCF Yield" },
    ],
    secondaryValuation: [
      { id: "pe_forward", label: "Forward P/E" },
      { id: "rule_of_40", label: "Rule of 40", guidance: "growth% + FCF margin% ≥ 40 (SaaS)" },
    ],
    forbiddenMetrics: [
      { id: "pb", reason: "asset-light — book value ไม่สะท้อนมูลค่า IP/software" },
    ],
    keyOperationalMetrics: [
      { id: "revenue_growth", label: "Revenue Growth YoY" },
      { id: "gross_margin", label: "Gross Margin", guidance: "software >70%, hardware/semi 40-60%" },
      { id: "rd_intensity", label: "R&D % of Revenue" },
      { id: "nrr", label: "Net Revenue Retention (SaaS)" },
    ],
    interpretationTraps: [
      "Semiconductor เป็น sub-cyclical ใน sector growth — ดู inventory cycle และ book-to-bill ด้วย",
      "Stock-based compensation สูง → GAAP EPS ต่ำกว่าจริง ดู FCF ประกอบ",
    ],
    screenerAdjustment: { mode: "standard", minEpsGrowthPct: 25, notes: "เกณฑ์ IBD ใช้ได้ตรงๆ" },
    macroSensitivities: ["ai_capex_cycle", "interest_rate_duration", "usd_strength", "export_controls"],
  },

  health_care: {
    sector: "health_care",
    displayName: "Health Care",
    cyclicality: "defensive",
    primaryValuation: [
      { id: "pe_forward", label: "Forward P/E" },
      { id: "ev_ebitda", label: "EV/EBITDA" },
      { id: "pipeline_adjusted_dcf", label: "Pipeline-adjusted DCF", guidance: "pharma: มูลค่า = ยาปัจจุบัน + pipeline คูณ probability" },
    ],
    secondaryValuation: [{ id: "peg", label: "PEG" }],
    forbiddenMetrics: [
      { id: "pe_trailing", reason: "biotech pre-revenue: P/E ไม่มีความหมาย — ใช้ cash runway แทน" },
    ],
    keyOperationalMetrics: [
      { id: "patent_cliff", label: "Patent Cliff Schedule", guidance: "รายได้กี่ % หมดสิทธิบัตรใน 5 ปี" },
      { id: "fda_pipeline", label: "FDA Pipeline (Phase II/III)" },
      { id: "cash_runway", label: "Cash Runway (quarters)", guidance: "biotech: สำคัญกว่ากำไร" },
      { id: "rd_productivity", label: "R&D Productivity" },
    ],
    interpretationTraps: [
      "Biotech ขาดทุน ≠ บริษัทแย่ — ดู runway + pipeline value",
      "กำไรกระโดดปีเดียวจาก milestone payment อย่านับเป็น recurring",
    ],
    screenerAdjustment: { mode: "relaxed", minEpsGrowthPct: 15, notes: "pharma โตช้ากว่า tech แต่ durable; biotech ใช้เกณฑ์ EPS ไม่ได้เลย ให้ดู pipeline" },
    macroSensitivities: ["drug_pricing_policy", "fda_regime", "demographics_aging"],
  },

  financials: {
    sector: "financials",
    displayName: "Financials",
    cyclicality: "cyclical",
    primaryValuation: [
      { id: "pb", label: "P/B", guidance: "คู่กับ ROE เสมอ: P/B สูงต้อง justify ด้วย ROE สูง" },
      { id: "roe", label: "ROE" },
    ],
    secondaryValuation: [{ id: "pe_forward", label: "Forward P/E" }, { id: "div_yield", label: "Dividend Yield" }],
    forbiddenMetrics: [
      { id: "ev_ebitda", reason: "หนี้คือวัตถุดิบของแบงก์ — EV และ EBITDA ไม่มีความหมาย" },
      { id: "ev_sales", reason: "เหตุผลเดียวกับ EV/EBITDA" },
      { id: "fcf_yield", reason: "FCF ของสถาบันการเงินคำนวณแบบบริษัททั่วไปไม่ได้" },
    ],
    keyOperationalMetrics: [
      { id: "nim", label: "Net Interest Margin" },
      { id: "npl_ratio", label: "NPL Ratio" },
      { id: "cet1", label: "CET1 Capital Ratio" },
      { id: "combined_ratio", label: "Combined Ratio (ประกัน)", guidance: "<100% = underwriting กำไร" },
      { id: "credit_cost", label: "Credit Cost / Provisions" },
    ],
    interpretationTraps: [
      "P/E ต่ำตอนปลาย credit cycle = กับดัก (กำไร peak ก่อน NPL โผล่)",
      "ROE พุ่งจาก leverage ไม่ใช่จาก operating — เช็ค equity multiplier",
    ],
    screenerAdjustment: { mode: "relaxed", minEpsGrowthPct: 12, notes: "แบงก์โต 25%/ปี ต่อเนื่อง = สัญญาณเสี่ยง (ปล่อยกู้หลวม) ไม่ใช่สัญญาณดี" },
    macroSensitivities: ["yield_curve", "credit_cycle", "policy_rate", "regulation_capital"],
  },

  consumer_discretionary: {
    sector: "consumer_discretionary",
    displayName: "Consumer Discretionary",
    cyclicality: "cyclical",
    primaryValuation: [
      { id: "pe_forward", label: "Forward P/E" },
      { id: "ev_ebitda", label: "EV/EBITDA" },
    ],
    secondaryValuation: [{ id: "peg", label: "PEG" }, { id: "fcf_yield", label: "FCF Yield" }],
    forbiddenMetrics: [],
    keyOperationalMetrics: [
      { id: "sss_growth", label: "Same-Store Sales Growth" },
      { id: "inventory_turnover", label: "Inventory Turnover", guidance: "inventory บวมก่อนยอดตก = red flag นำ" },
      { id: "gross_margin_trend", label: "Gross Margin Trend", guidance: "วัด pricing power" },
    ],
    interpretationTraps: [
      "P/E ต่ำตอน consumer cycle peak = แพงจริง (earnings กำลังจะตก)",
      "ยอดโตจากเปิดสาขา ≠ SSS โต — แยกให้ออก",
    ],
    screenerAdjustment: { mode: "standard", minEpsGrowthPct: 25, notes: "แต่ต้อง overlay consumer cycle position" },
    macroSensitivities: ["consumer_confidence", "employment", "policy_rate", "tariffs"],
  },

  consumer_staples: {
    sector: "consumer_staples",
    displayName: "Consumer Staples",
    cyclicality: "defensive",
    primaryValuation: [
      { id: "pe_forward", label: "Forward P/E", guidance: "เทียบ historical band ของตัวเอง ไม่ใช่ตลาด" },
      { id: "div_yield", label: "Dividend Yield + consistency" },
    ],
    secondaryValuation: [{ id: "ev_ebitda", label: "EV/EBITDA" }, { id: "fcf_yield", label: "FCF Yield" }],
    forbiddenMetrics: [],
    keyOperationalMetrics: [
      { id: "organic_growth", label: "Organic Volume vs Price Growth", guidance: "โตจาก volume = แข็งแรง, โตจากขึ้นราคาอย่างเดียว = เปราะ" },
      { id: "div_streak", label: "Dividend Streak (years)" },
      { id: "brand_pricing_power", label: "Pricing Power / Market Share" },
    ],
    interpretationTraps: ["EPS โตจาก buyback ล้วนๆ ไม่ใช่ธุรกิจโต — แตก EPS growth เป็น components"],
    screenerAdjustment: { mode: "exclude", minEpsGrowthPct: null, notes: "IBD-style growth screen ไม่มีทางผ่าน — คัดผ่าน dividend/quality screen แยกต่างหาก (เหมือน IBD จริงที่ list แทบไม่มี staples)" },
    macroSensitivities: ["input_cost_inflation", "fx_translation", "private_label_competition"],
  },

  communication_services: {
    sector: "communication_services",
    displayName: "Communication Services",
    cyclicality: "secular_growth",
    primaryValuation: [
      { id: "ev_ebitda", label: "EV/EBITDA" },
      { id: "peg", label: "PEG" },
      { id: "fcf_yield", label: "FCF Yield" },
    ],
    secondaryValuation: [{ id: "ev_sales", label: "EV/Sales" }],
    forbiddenMetrics: [],
    keyOperationalMetrics: [
      { id: "dau_mau", label: "DAU/MAU + ARPU (platform)" },
      { id: "content_spend", label: "Content Spend vs Sub Growth (media)" },
      { id: "churn", label: "Churn Rate (telecom/streaming)" },
    ],
    interpretationTraps: [
      "Sector นี้ปนกัน 2 พันธุ์: internet platform (growth) กับ telecom เก่า (rate-sensitive value) — ใช้เกณฑ์คนละชุด",
      "Ad revenue เป็น cyclical แฝงใน sector ที่ดูเป็น growth",
    ],
    screenerAdjustment: { mode: "standard", minEpsGrowthPct: 25, notes: "ใช้กับ platform; telecom เก่าให้ตกไปอยู่เกณฑ์ dividend" },
    macroSensitivities: ["ad_spend_cycle", "regulation_antitrust", "ai_capex_cycle"],
  },

  industrials: {
    sector: "industrials",
    displayName: "Industrials",
    cyclicality: "cyclical",
    primaryValuation: [
      { id: "ev_ebitda", label: "EV/EBITDA" },
      { id: "pe_mid_cycle", label: "P/E on mid-cycle earnings", guidance: "normalize earnings ก่อน อย่าใช้ peak/trough ตรงๆ" },
    ],
    secondaryValuation: [{ id: "fcf_yield", label: "FCF Yield" }],
    forbiddenMetrics: [],
    keyOperationalMetrics: [
      { id: "backlog", label: "Backlog / Order Book", guidance: "leading indicator ตัวจริงของ sector นี้" },
      { id: "book_to_bill", label: "Book-to-Bill Ratio", guidance: ">1 = demand โต" },
      { id: "operating_leverage", label: "Operating Leverage" },
      { id: "capex_cycle", label: "Customer Capex Cycle Position" },
    ],
    interpretationTraps: [
      "P/E ต่ำที่ peak cycle = กับดักคลาสสิก",
      "Backlog โตแต่ margin หด = รับงานราคาถูกไล่ยอด",
    ],
    screenerAdjustment: { mode: "relaxed", minEpsGrowthPct: 15, notes: "ยอมรับ growth ต่ำกว่า tech แต่ต้องมี backlog momentum ประกอบ" },
    macroSensitivities: ["capex_cycle", "pmi", "infrastructure_policy", "freight_rates"],
  },

  energy: {
    sector: "energy",
    displayName: "Energy",
    cyclicality: "cyclical",
    primaryValuation: [
      { id: "fcf_yield", label: "FCF Yield", guidance: "metric หลักของ sector ยุคนี้ (คืนเงินผู้ถือหุ้น)" },
      { id: "ev_ebitda_strip", label: "EV/EBITDA on strip pricing", guidance: "ใช้ futures strip ไม่ใช่ spot" },
    ],
    secondaryValuation: [{ id: "pb", label: "P/B (asset-heavy)" }, { id: "div_yield", label: "Dividend + Buyback Yield" }],
    forbiddenMetrics: [
      { id: "pe_trailing", reason: "P/E ต่ำตอนราคาน้ำมัน peak = กับดัก cyclical เต็มรูปแบบ" },
      { id: "peg", reason: "growth ของ sector นี้คือ function ของ commodity price ไม่ใช่ธุรกิจ" },
    ],
    keyOperationalMetrics: [
      { id: "production_cost", label: "Production Cost Curve Position (breakeven $/bbl)" },
      { id: "reserve_life", label: "Reserve Life (years)" },
      { id: "capital_discipline", label: "Capex Discipline / Payout Framework" },
    ],
    interpretationTraps: [
      "Valuation ทุกตัวต้องถามก่อนว่า 'ที่ราคาน้ำมันเท่าไหร่?' — วิเคราะห์ without commodity assumption = ไร้ความหมาย",
      "Earnings สวยตอน spot สูง ไม่บอกอะไรเรื่อง through-cycle economics",
    ],
    screenerAdjustment: { mode: "exclude", minEpsGrowthPct: null, notes: "EPS growth screen จับ cyclical rebound ไม่ใช่ quality — คัดด้วย FCF yield + cost curve แทน" },
    macroSensitivities: ["oil_gas_price", "opec_policy", "energy_transition_policy", "china_demand"],
  },

  materials: {
    sector: "materials",
    displayName: "Materials",
    cyclicality: "cyclical",
    primaryValuation: [
      { id: "ev_ebitda_mid_cycle", label: "EV/EBITDA mid-cycle" },
      { id: "fcf_yield", label: "FCF Yield" },
      { id: "pb", label: "P/B" },
    ],
    secondaryValuation: [{ id: "replacement_cost", label: "EV vs Replacement Cost" }],
    forbiddenMetrics: [
      { id: "pe_trailing", reason: "กับดัก cyclical เดียวกับ energy" },
    ],
    keyOperationalMetrics: [
      { id: "cost_curve", label: "Cost Curve Position (quartile)" },
      { id: "capacity_utilization", label: "Industry Capacity Utilization" },
      { id: "china_exposure", label: "China Demand Exposure %" },
    ],
    interpretationTraps: [
      "ดู supply side เป็นหลัก: capacity ใหม่กำลังเข้าตลาด = margin จะโดนบีบไม่ว่า demand ดีแค่ไหน",
      "Specialty chemicals ≠ commodity chemicals — พันธุ์แรกวัดแบบ quality ได้",
    ],
    screenerAdjustment: { mode: "exclude", minEpsGrowthPct: null, notes: "เหมือน energy — ใช้ cycle position + cost curve แทน EPS screen" },
    macroSensitivities: ["china_demand", "commodity_prices", "usd_strength", "construction_cycle"],
  },

  real_estate: {
    sector: "real_estate",
    displayName: "Real Estate",
    cyclicality: "rate_sensitive",
    primaryValuation: [
      { id: "p_ffo", label: "P/FFO", guidance: "แทน P/E เสมอ — depreciation บิด EPS จนใช้ไม่ได้" },
      { id: "p_affo", label: "P/AFFO", guidance: "เข้มกว่า FFO (หัก maintenance capex)" },
      { id: "nav_discount", label: "Premium/Discount to NAV" },
    ],
    secondaryValuation: [{ id: "div_yield", label: "Dividend Yield vs 10Y", guidance: "spread เทียบ bond สำคัญกว่า yield เดี่ยวๆ" }, { id: "implied_cap_rate", label: "Implied Cap Rate" }],
    forbiddenMetrics: [
      { id: "pe_trailing", reason: "depreciation ทำ EPS ต่ำเทียม — REIT ที่ดูแพงด้วย P/E อาจถูกด้วย FFO" },
      { id: "eps_growth", reason: "ใช้ FFO/share growth แทน" },
    ],
    keyOperationalMetrics: [
      { id: "occupancy", label: "Occupancy Rate" },
      { id: "sp_noi_growth", label: "Same-Property NOI Growth" },
      { id: "debt_maturity", label: "Debt Maturity Wall + Fixed/Float Mix" },
      { id: "cap_rate_spread", label: "Cap Rate vs Funding Cost Spread" },
    ],
    interpretationTraps: [
      "ทุก metric ปกติของ akeguru ที่อิง EPS ต้อง remap เป็น FFO ก่อน ไม่งั้น pipeline ตีความผิดทั้งรายงาน",
      "Dividend สูงแต่ AFFO payout >100% = จ่ายจากการกู้ ไม่ยั่งยืน",
    ],
    screenerAdjustment: { mode: "exclude", minEpsGrowthPct: null, notes: "EPS-based screen ใช้ไม่ได้โดยนิยาม — ต้องมี FFO-based screen แยก" },
    macroSensitivities: ["policy_rate", "bond_yield_10y", "credit_availability", "wfh_structural"],
  },

  utilities: {
    sector: "utilities",
    displayName: "Utilities",
    cyclicality: "rate_sensitive",
    primaryValuation: [
      { id: "pe_forward", label: "Forward P/E", guidance: "เทียบ regulated ROE + rate base growth" },
      { id: "div_yield_spread", label: "Dividend Yield vs 10Y Treasury", guidance: "spread แคบ = แพง (bond proxy)" },
    ],
    secondaryValuation: [{ id: "ev_ebitda", label: "EV/EBITDA" }, { id: "p_rate_base", label: "Premium to Rate Base" }],
    forbiddenMetrics: [],
    keyOperationalMetrics: [
      { id: "regulated_roe", label: "Allowed/Earned ROE" },
      { id: "rate_base_growth", label: "Rate Base Growth %", guidance: "ตัวขับ EPS ที่แท้จริงของ regulated utility" },
      { id: "debt_load", label: "Debt/EBITDA", guidance: "sensitive ดอกเบี้ยมากที่สุดใน 11 sectors" },
      { id: "regulatory_regime", label: "Regulatory Jurisdiction Quality" },
    ],
    interpretationTraps: [
      "หุ้นลงเพราะ bond yield ขึ้น ≠ ธุรกิจแย่ลง — แยก rate effect ออกจาก fundamental",
      "Data center demand เป็น re-rating story ใหม่ของ sector — utility ที่มี exposure ต่างจากตัวที่ไม่มีมาก",
    ],
    screenerAdjustment: { mode: "exclude", minEpsGrowthPct: null, notes: "โตช้าโดยธรรมชาติ (rate base 5-8%/ปี) — คัดผ่าน dividend + rate base screen แทน" },
    macroSensitivities: ["policy_rate", "bond_yield_10y", "power_demand_ai", "renewable_policy"],
  },
};

// ─────────────────────────────────────────────────────────────
// Helpers — จุดเสียบเข้า pipeline
// ─────────────────────────────────────────────────────────────

/** ดึง profile; throw ถ้า sector ไม่รู้จัก (บังคับ classify ก่อนวิเคราะห์) */
export function getSectorProfile(sector: GicsSector): SectorProfile {
  const p = SECTOR_PROFILES[sector];
  if (!p) throw new Error(`Unknown GICS sector: ${sector}`);
  return p;
}

/**
 * สร้างข้อความ guidance สำหรับ inject เข้า valuation agent prompt
 * — นี่คือกลไกหลักที่ทำให้ agent "เลือก metric ตาม sector อัตโนมัติ"
 */
export function buildValuationGuidance(sector: GicsSector): string {
  const p = getSectorProfile(sector);
  const lines: string[] = [
    `SECTOR: ${p.displayName} (${p.cyclicality})`,
    `PRIMARY METRICS (ต้องใช้อย่างน้อย 1): ${p.primaryValuation.map(m => m.label + (m.guidance ? ` — ${m.guidance}` : "")).join("; ")}`,
    `SECONDARY: ${p.secondaryValuation.map(m => m.label).join(", ")}`,
  ];
  if (p.forbiddenMetrics.length > 0) {
    lines.push(`FORBIDDEN (ห้ามใช้เป็น valuation signal): ${p.forbiddenMetrics.map(f => `${f.id} (${f.reason})`).join("; ")}`);
  }
  lines.push(`INTERPRETATION TRAPS:\n${p.interpretationTraps.map(t => `- ${t}`).join("\n")}`);
  lines.push(`OPERATIONAL KPIs ที่ควรอ้างอิง: ${p.keyOperationalMetrics.map(m => m.label).join(", ")}`);
  return lines.join("\n");
}

/**
 * Gate check: agent ใช้ forbidden metric เป็นสาระสำคัญหรือไม่
 * ใช้ใน gate layer (เสนอเป็นส่วนหนึ่งของ Gate 2 consistency หรือ gate ใหม่)
 */
export function validateMetricUsage(
  sector: GicsSector,
  metricsUsed: string[],
): { pass: boolean; violations: { id: string; reason: string }[] } {
  const p = getSectorProfile(sector);
  const violations = p.forbiddenMetrics.filter(f => metricsUsed.includes(f.id));
  const usedPrimary = p.primaryValuation.some(m => metricsUsed.includes(m.id));
  return {
    pass: violations.length === 0 && usedPrimary,
    violations: !usedPrimary && violations.length === 0
      ? [{ id: "missing_primary", reason: `ไม่ได้ใช้ primary metric ของ ${p.displayName} เลย` }]
      : violations,
  };
}

/** Screener adjustment สำหรับ stocklens / IBD50-style theme */
export function getScreenerAdjustment(sector: GicsSector) {
  return getSectorProfile(sector).screenerAdjustment;
}

/** map จากชื่อ sector ที่ data source ต่างๆ ใช้ (yfinance, Fiscal.ai) → GICS enum */
export const SECTOR_ALIASES: Record<string, GicsSector> = {
  "Technology": "information_technology",
  "Information Technology": "information_technology",
  "Healthcare": "health_care",
  "Health Care": "health_care",
  "Financial Services": "financials",
  "Financials": "financials",
  "Consumer Cyclical": "consumer_discretionary",
  "Consumer Discretionary": "consumer_discretionary",
  "Consumer Defensive": "consumer_staples",
  "Consumer Staples": "consumer_staples",
  "Communication Services": "communication_services",
  "Industrials": "industrials",
  "Energy": "energy",
  "Basic Materials": "materials",
  "Materials": "materials",
  "Real Estate": "real_estate",
  "Utilities": "utilities",
};

export function normalizeSector(raw: string): GicsSector {
  const s = SECTOR_ALIASES[raw.trim()];
  if (!s) throw new Error(`Cannot map sector "${raw}" to GICS — เพิ่ม alias ใน SECTOR_ALIASES`);
  return s;
}
