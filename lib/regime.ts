/**
 * Regime Detection (Phase 3 roadmap item, "Regime Detection + mapping thesis <-> regime"). Pure,
 * DB-free classification (same reasoning as lib/scoring.ts) -- lib/refresh.ts supplies the numbers
 * and persists the result as MarketRegime.
 *
 * No real macro/index data exists anywhere in this pipeline (no VIX, no yield curve, no S&P 500 or
 * SET index series -- confirmed while scoping this: the Factor Sensitivity Agent hit the same gap
 * and had to stay qualitative for the same reason). Building a genuine macro-factor regime model
 * would mean ingesting index/macro series this app doesn't have yet -- real, meaningfully bigger
 * scope, not something to fake with a plausible-looking placeholder.
 *
 * What's available instead: the tracked universe's own price history. Market breadth (% of the
 * cohort with positive 3-month price return) is a real, standard technical-analysis signal --
 * confirmed live against the actual universe: TH 85.4% breadth / +13.7% avg, US 64.2% / +3.8%, HK
 * 56.4% / +1.9%, a sensible and differentiated read across three markets from data already being
 * collected daily. Per-market only, same reasoning lib/scoring.ts's cohorts never mix TH/US/HK.
 */

export type RegimeClassification = "RISK_ON" | "RISK_OFF" | "MIXED";

const MIN_COHORT_SIZE = 10; // same floor lib/scoring.ts uses before trusting a cohort-wide signal
const BREADTH_RISK_ON = 0.60; // >=60% of the cohort up over 3 months, and the average return is positive
const BREADTH_RISK_OFF = 0.40; // <=40% of the cohort up over 3 months, and the average return is negative

export interface RegimeResult {
  breadthPct: number; // fraction, e.g. 0.854 for 85.4%
  avgReturn3m: number; // fraction
  classification: RegimeClassification;
  cohortSize: number;
}

/** `returns3m`: one entry per stock in the market cohort, null where priceReturn() couldn't compute
 *  one (e.g. a newly-added ticker with <8 weeks of history) -- filtered out, not treated as 0%. */
export function classifyRegime(returns3m: Array<number | null>): RegimeResult | null {
  const valid = returns3m.filter((r): r is number => r != null);
  if (valid.length < MIN_COHORT_SIZE) return null;

  const positiveCount = valid.filter((r) => r > 0).length;
  const breadthPct = positiveCount / valid.length;
  const avgReturn3m = valid.reduce((a, b) => a + b, 0) / valid.length;

  const classification: RegimeClassification =
    breadthPct >= BREADTH_RISK_ON && avgReturn3m > 0
      ? "RISK_ON"
      : breadthPct <= BREADTH_RISK_OFF && avgReturn3m < 0
        ? "RISK_OFF"
        : "MIXED";

  return { breadthPct, avgReturn3m, classification, cohortSize: valid.length };
}
