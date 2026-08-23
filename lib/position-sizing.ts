/**
 * Position Sizing Model (Phase 5 roadmap item). Pure, DB-free sizing calculator (same reasoning as
 * lib/regime.ts / lib/lynch.ts) -- scripts/position-sizing.ts supplies conviction (from a real GO
 * ResearchReport) and realized volatility (computed from real PriceHistory).
 *
 * Deliberately NOT a Kelly criterion calculation: Kelly needs a real edge (win probability, win/loss
 * payoff ratio) to size correctly, and conviction (1-5) is not a probability -- treating it as one
 * would fabricate a precise-looking number with nothing real behind it, the same failure mode this
 * whole pipeline's grounding checks exist to catch elsewhere (see lib/agents/grounding.ts). Instead
 * this is inverse-volatility (risk-parity-style) sizing: a position sized so its *dollar risk
 * contribution* is comparable across positions regardless of how volatile the individual stock is,
 * scaled up or down by conviction as a secondary multiplier. A standard, defensible heuristic -- a
 * starting suggestion a human still has to size-check and sign off on, not an automated allocator.
 */

// Documented, revisitable assumptions (same posture as lib/regime.ts's breadth thresholds /
// scripts/read-across.ts's MATERIAL_CHANGE_THRESHOLD_PCT) -- not a validated, backtested model.
export const REFERENCE_ANNUALIZED_VOL = 0.3; // ~typical large-cap equity annualized vol; a stock at exactly this vol gets the unscaled "anchor" weight
export const ANCHOR_WEIGHT_PCT = 5; // suggested % of capital for conviction=3 (the minimum GO conviction, synthesis.md rule 8) at reference volatility
export const CONVICTION_MULTIPLIER: Record<number, number> = { 3: 1.0, 4: 1.5, 5: 2.0 };
export const MIN_POSITION_PCT = 2;
export const MAX_POSITION_PCT = 15; // hard concentration cap -- no single suggestion exceeds this regardless of conviction/volatility
export const MIN_WEEKS_FOR_VOL = 20; // fewer weekly closes than this (~5 months) and a stdev isn't a meaningful volatility estimate

export interface PositionSizeResult {
  suggestedWeightPct: number;
  annualizedVol: number;
  convictionMultiplier: number;
  volAdjustment: number;
}

/** weeklyCloses ordered oldest -> newest, ideally trailing ~52 weeks. lib/refresh.ts's
 *  fetchWeeklyPriceHistory is the only price granularity this app stores (see lib/yahoo.ts) --
 *  PriceHistory rows are ~7 days apart, not daily, so this annualizes via sqrt(52), NOT the
 *  sqrt(252) trading-day convention. Using 252 here would understate every stock's real volatility
 *  by roughly 2.2x (sqrt(252/52)) since each row already spans a full week of price movement, not a
 *  single day -- caught live testing this against real MSFT data (a naive sqrt(252) version read
 *  70.7% annualized vol off 65 *weekly* closes, implausibly high for a mega-cap; the math was
 *  double-counting each week's move as if it were 5 separate daily moves). Log returns (not simple %
 *  returns) -- standard for annualizing via sqrt(time), and symmetric for up/down moves of the same
 *  magnitude, which simple returns aren't. */
export function computeAnnualizedVolatility(weeklyCloses: number[]): number | null {
  const returns: number[] = [];
  for (let i = 1; i < weeklyCloses.length; i++) {
    const prev = weeklyCloses[i - 1];
    const curr = weeklyCloses[i];
    if (prev <= 0 || curr <= 0) continue; // guard a bad/zero close row rather than propagate NaN/Infinity
    returns.push(Math.log(curr / prev));
  }
  if (returns.length < MIN_WEEKS_FOR_VOL - 1) return null;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(52); // 52 weeks/year -- see doc comment above for why not 252
}

/** null when conviction < 3 (not a GO-quality conviction -- WAIT/NO_GO don't get sized at all, and a
 *  GO with conviction < 3 would itself be a synthesis-agent rule violation, not a real signal to size
 *  against) or volatility can't be computed (not enough real price history) -- returning null instead
 *  of a fabricated number for either case, same "don't guess from missing data" rule as everywhere
 *  else in this pipeline. */
export function suggestPositionSize(conviction: number, annualizedVol: number | null): PositionSizeResult | null {
  if (conviction < 3 || annualizedVol === null || annualizedVol <= 0) return null;

  const convictionMultiplier = CONVICTION_MULTIPLIER[conviction] ?? 1.0;
  const volAdjustment = REFERENCE_ANNUALIZED_VOL / annualizedVol;
  const raw = ANCHOR_WEIGHT_PCT * convictionMultiplier * volAdjustment;
  const suggestedWeightPct = Math.min(MAX_POSITION_PCT, Math.max(MIN_POSITION_PCT, raw));

  return { suggestedWeightPct, annualizedVol, convictionMultiplier, volAdjustment };
}
