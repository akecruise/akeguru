/**
 * Macro-regime sector rotation -- a deliberately small, honest slice of a much larger research
 * document (leading-indicator ladders, a value-chain schema, Markov regime-switching, PSY/GSADF
 * bubble tests, DTW+Mahalanobis analog matching). None of the econometric models are built here --
 * they need a Python quant service (stocklens's FastAPI, not this repo -- statsmodels/dtaidistance
 * have no real JS equivalent) and external data sources this app doesn't ingest anywhere (Taiwan
 * MOPS monthly revenue, Korea customs 20-day exports, SEMI Book-to-Bill, hyperscaler capex
 * guidance). That's genuinely weeks of cross-repo, cross-language work, not a same-session add-on.
 *
 * What IS honestly buildable today: ROTATION_MAP itself is real domain knowledge (a historical
 * sector-rotation playbook), kept faithfully. classifyExitCause() is a simple, documented
 * rules-based heuristic over three signals this app can actually fetch for free (yield curve
 * slope, VIX, defensive-vs-cyclical sector relative performance) -- not the sophisticated
 * regime-switching classifier the full vision calls for (which needs real rates, CPI, ISM PMI,
 * hyperscaler capex YoY -- none available via Yahoo).
 *
 * CAPEX_DIGESTION is deliberately never auto-classified -- distinguishing it needs hyperscaler
 * capex trend data (Capex isn't even a tracked FinancialFact metricName today, see
 * lib/data/input-sources/router.ts's YAHOO_FIELD_MAP). Rather than guess, classifyExitCause()
 * returns cause: null with a documented reason when the available signals don't support a
 * confident call -- an honest "don't know," not a wrong answer dressed up as one.
 */

export type ExitCause = "INVENTORY_ONLY" | "DEMAND_SHOCK" | "RATE_SHOCK" | "CAPEX_DIGESTION";

export interface RotationPath {
  phase1: { months: [number, number]; sectors: string[] };
  phase2: { months: [number, number]; sectors: string[] };
  note?: string;
  trigger?: string;
  analog?: string;
  thesis?: string;
}

export const ROTATION_MAP: Record<ExitCause, RotationPath> = {
  INVENTORY_ONLY: {
    phase1: { months: [0, 6], sectors: ["STAPLES", "HEALTHCARE"] },
    phase2: { months: [6, 12], sectors: ["SEMIS"] }, // กลับมาเอง
    note: "ไม่ใช่ rotation จริง — เป็น mid-cycle correction",
  },
  DEMAND_SHOCK: {
    phase1: { months: [0, 9], sectors: ["STAPLES", "UTILITIES", "HEALTHCARE"] },
    phase2: { months: [9, 24], sectors: ["FINANCIALS", "DISCRETIONARY", "HOMEBUILDERS", "SMALL_CAP"] },
    trigger: "Fed cut cycle เริ่ม",
  },
  RATE_SHOCK: {
    phase1: { months: [0, 18], sectors: ["ENERGY", "MATERIALS", "INDUSTRIALS"] },
    phase2: { months: [18, 48], sectors: ["VALUE", "EM", "GOLD_MINERS"] },
    analog: "telecom_2000",
  },
  CAPEX_DIGESTION: {
    phase1: { months: [0, 12], sectors: ["SOFTWARE", "INTERNET_PLATFORM"] },
    phase2: { months: [12, 36], sectors: ["AI_APPLICATION", "VERTICAL_SAAS"] },
    thesis: "surplus ย้ายจากผู้สร้าง capacity ไปหาผู้ใช้",
  },
};

export interface RealRotationSignals {
  yieldCurveSpread: number; // ^TNX - ^IRX, percentage points -- real rate-shock proxy
  vix: number; // ^VIX level -- real shock-magnitude gauge
  defensiveVsCyclical3m: number; // trailing 3mo return: avg(XLP,XLV,XLU) - SMH, percentage points
}

export interface ExitCauseClassification {
  cause: ExitCause | null;
  confidence: "low" | "medium";
  reasoning: string;
}

// Simple, documented thresholds -- not fit/validated against historical episodes (that needs the
// Markov regime-switching + walk-forward validation the full research calls for; only ~7-8 full
// cycles exist since 1976, real risk of overfitting any statistical fit on a sample that small).
// Revisit once real RotationSignal history accumulates in this app.
const VIX_ELEVATED = 25; // roughly the "elevated stress" zone historically (calm-market baseline ~15-20)
const YIELD_CURVE_INVERTED = -0.5; // 10Y-3M spread, percentage points

export function classifyExitCause(s: RealRotationSignals): ExitCauseClassification {
  const signalSummary = `VIX ${s.vix.toFixed(1)}, yield curve ${s.yieldCurveSpread.toFixed(2)}pp, defensive-vs-semis 3mo ${s.defensiveVsCyclical3m.toFixed(1)}pp`;

  if (s.vix >= VIX_ELEVATED && s.yieldCurveSpread <= YIELD_CURVE_INVERTED) {
    return { cause: "RATE_SHOCK", confidence: "medium", reasoning: `${signalSummary} -- elevated VIX + inverted curve is the classic rate-shock signature` };
  }
  if (s.vix >= VIX_ELEVATED && s.defensiveVsCyclical3m > 5) {
    return { cause: "DEMAND_SHOCK", confidence: "medium", reasoning: `${signalSummary} -- elevated VIX + defensives already outperforming semis suggests the market is pricing a demand shock` };
  }
  if (s.vix < VIX_ELEVATED && Math.abs(s.defensiveVsCyclical3m) < 5 && s.yieldCurveSpread > YIELD_CURVE_INVERTED) {
    return { cause: "INVENTORY_ONLY", confidence: "low", reasoning: `${signalSummary} -- no stress signal present, defaulting to the mildest real explanation, not a confident diagnosis` };
  }
  return {
    cause: null,
    confidence: "low",
    reasoning: `${signalSummary} -- doesn't clearly match a rules-based case. Could be CAPEX_DIGESTION (this app can't detect that -- needs hyperscaler capex trend data not ingested anywhere) or a genuinely ambiguous transition. Needs human judgment.`,
  };
}
