/**
 * Expectation Gap Model (Phase 2 roadmap item) — a reverse DCF: solve for the growth rate the
 * *current market price* requires over an explicit forecast window, then compare it against what
 * looks achievable (historical revenue CAGR / analyst consensus) to flag "GO but not now" — a good
 * business priced for more growth than it's likely to deliver, vs. one priced below what it can
 * plausibly do. Pure, DB-free math (same reasoning as lib/scoring.ts/lib/report/estimates.ts) — the
 * orchestrator supplies the numbers, nothing in here talks to Postgres.
 *
 * Two-stage Gordon Growth (an explicit N-year stage at g1, then a terminal perpetuity at a fixed
 * long-run rate), not single-stage — confirmed live against a real MSFT run that single-stage badly
 * distorts for a low-FCF-yield large-cap: it solved to an implied growth *below* both historical
 * CAGR and analyst estimates (reading as "undervalued"), directly contradicting that same report's
 * own bear case (P/E 26.95x, "priced for perfection"). Two-stage + a normalized FCF base resolved
 * it to a coherent ~31% implied 5yr growth vs. ~15-20% achievable — consistent with the rest of
 * that report.
 *
 * The FCF base is a multi-year average of (CFO - Capex) from real FinancialFact rows (see
 * computeNormalizedFcf), not Yahoo's single "FCF" snapshot — confirmed live those two disagree by
 * ~4x for MSFT ($16.5B Yahoo vs. ~$71B CFO-Capex), and the single-year Yahoo figure is exactly what
 * made single-stage's distortion worst (a capex-spike year, not a representative one).
 *
 * Every constant below is a stated, revisitable assumption, not a fitted/validated model — there's
 * no live risk-free-rate feed or market ERP estimate wired up. Revisit once real WAIT/regret
 * history (scripts/scorecard.ts) or an actual "priced for perfection" call playing out (or not)
 * says these are off.
 */

export const RISK_FREE_RATE: Record<"USD" | "THB" | "HKD", number> = {
  USD: 0.04,
  HKD: 0.04, // HKD is USD-pegged -- same real economic environment
  THB: 0.025, // Thai government bond yield ballpark, not live-fetched
};
export const EQUITY_RISK_PREMIUM = 0.05; // Damodaran-style long-run US ERP ballpark
export const TERMINAL_GROWTH_RATE = 0.035; // long-run nominal-GDP-ish ceiling for the perpetuity stage
export const EXPLICIT_STAGE_YEARS = 5;
export const FCF_NORMALIZATION_YEARS = 3;
const GAP_THRESHOLD_PP = 5; // +/- 5 percentage points of achievable growth counts as "reasonable"

export interface ExpectationGapInput {
  marketCap: number;
  beta: number;
  currency: "USD" | "THB" | "HKD";
  normalizedFcf: number; // already averaged by the caller -- see computeNormalizedFcf
  achievableGrowthRate: number; // fraction, e.g. 0.15 for 15% -- blended analyst/historical, caller's job to pick (see lib/report/orchestrator.ts)
}

export interface ExpectationGapResult {
  requiredReturn: number; // fraction -- CAPM cost of equity used as the discount rate
  impliedGrowthRate: number; // fraction -- the g1 the current price requires over EXPLICIT_STAGE_YEARS
  achievableGrowthRate: number; // fraction -- echoes the input, so a reader doesn't have to cross-reference
  gapPct: number; // impliedGrowthRate - achievableGrowthRate, in PERCENTAGE POINTS (not a fraction)
  classification: "priced-for-perfection" | "reasonable" | "undervalued-expectations" | "unreliable";
}

function pvTwoStage(fcf0: number, g1: number, gTerminal: number, r: number, stageYears: number): number {
  let pv = 0;
  let fcfT = fcf0;
  for (let t = 1; t <= stageYears; t++) {
    fcfT *= 1 + g1;
    pv += fcfT / (1 + r) ** t;
  }
  const terminalValue = (fcfT * (1 + gTerminal)) / (r - gTerminal);
  return pv + terminalValue / (1 + r) ** stageYears;
}

/** Bisection, not a closed form -- pvTwoStage is monotonically increasing in g1 (more growth ->
 *  more value), so this always converges. Bounded to [-50%, +60%]: outside that range the result
 *  isn't a meaningful growth expectation anyway (see the 'unreliable' classification below). */
function solveImpliedGrowth(marketCap: number, fcf0: number, r: number, gTerminal: number, stageYears: number): number {
  let lo = -0.5;
  let hi = 0.6;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (pvTwoStage(fcf0, mid, gTerminal, r, stageYears) < marketCap) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function computeExpectationGap(input: ExpectationGapInput): ExpectationGapResult | null {
  // A negative/zero FCF base isn't reverse-DCF-able this way (the model would solve for a
  // meaningless or undefined growth rate) -- e.g. a pre-profitability growth stock. No result
  // rather than a misleading one.
  if (input.normalizedFcf <= 0 || input.marketCap <= 0) return null;

  const riskFreeRate = RISK_FREE_RATE[input.currency];
  const requiredReturn = riskFreeRate + input.beta * EQUITY_RISK_PREMIUM;
  // CAPM can produce r <= TERMINAL_GROWTH_RATE for a very low/negative beta -- the terminal-value
  // formula divides by (r - gTerminal), so that's undefined/nonsensical here, not just unlikely.
  if (requiredReturn <= TERMINAL_GROWTH_RATE) return null;

  const impliedGrowthRate = solveImpliedGrowth(input.marketCap, input.normalizedFcf, requiredReturn, TERMINAL_GROWTH_RATE, EXPLICIT_STAGE_YEARS);
  const hitSearchBound = impliedGrowthRate >= 0.599 || impliedGrowthRate <= -0.499;
  const gapPct = (impliedGrowthRate - input.achievableGrowthRate) * 100;

  const classification: ExpectationGapResult["classification"] = hitSearchBound
    ? "unreliable"
    : gapPct > GAP_THRESHOLD_PP
      ? "priced-for-perfection"
      : gapPct < -GAP_THRESHOLD_PP
        ? "undervalued-expectations"
        : "reasonable";

  return { requiredReturn, impliedGrowthRate, achievableGrowthRate: input.achievableGrowthRate, gapPct, classification };
}

interface PeriodFact {
  metricName: string;
  value: number;
  period: string;
}

/** Multi-year average of (CFO - Capex) from real FinancialFact rows -- see this file's header
 *  comment for why not a single-year snapshot. Needs both tags present for the *same* period to
 *  pair them; a year missing either is skipped rather than guessed. Null if fewer than 1 pairable
 *  year exists (e.g. HK/TH tickers, which don't have SEC XBRL history at all). */
export function computeNormalizedFcf(facts: PeriodFact[]): number | null {
  const cfoByPeriod = new Map(facts.filter((f) => f.metricName === "NetCashProvidedByUsedInOperatingActivities").map((f) => [f.period, f.value]));
  const capexByPeriod = new Map(facts.filter((f) => f.metricName === "PaymentsToAcquirePropertyPlantAndEquipment").map((f) => [f.period, f.value]));

  const periods = [...cfoByPeriod.keys()]
    .filter((p) => capexByPeriod.has(p))
    .sort()
    .reverse()
    .slice(0, FCF_NORMALIZATION_YEARS);
  if (!periods.length) return null;

  const fcfValues = periods.map((p) => cfoByPeriod.get(p)! - capexByPeriod.get(p)!);
  return fcfValues.reduce((a, b) => a + b, 0) / fcfValues.length;
}

// Both US GAAP revenue tags map to the same economic concept -- a company reports under whichever
// one applies to it (see sec.ts's CORE_METRICS), never both, so combining them here is safe.
const REVENUE_TAGS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"];

/** CAGR between the earliest and latest annual revenue figure available (needs >= 2 years, and a
 *  positive base year -- same guards as lib/scoring.ts's cagr(), reimplemented here rather than
 *  imported since that one operates on FinancialHistory (the old refresh.ts pipeline), not
 *  FinancialFact (Compound OS) -- different data source, same math. */
export function computeRevenueCagr(facts: PeriodFact[]): number | null {
  const points = facts
    .filter((f) => REVENUE_TAGS.includes(f.metricName))
    .map((f) => ({ period: f.period, value: f.value }))
    .sort((a, b) => a.period.localeCompare(b.period));
  if (points.length < 2) return null;

  const first = points[0];
  const last = points[points.length - 1];
  if (first.value <= 0) return null;

  const years = (new Date(last.period).getTime() - new Date(first.period).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 1) return null;

  return Math.pow(last.value / first.value, 1 / years) - 1;
}
