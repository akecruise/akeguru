/**
 * Turtle Trading (Richard Dennis & William Eckhardt) -- Donchian channel breakout signals + ATR-
 * based ("N") position sizing. Pure, DB-free (same reasoning as lib/regime.ts): whether a breakout
 * happened is a mechanical fact read off price data, not something needing LLM interpretation, so
 * this is a calculator, not an agent -- same reasoning as lib/data/expectation-gap.ts and
 * lib/regime.ts.
 *
 * Rescaled from trading days to weeks: PriceHistory is weekly, not daily (lib/refresh.ts's
 * fetchWeeklyPriceHistory -- the same constraint lib/position-sizing.ts's doc comment already hit
 * for annualized volatility). Turtle's classic windows are re-expressed in their real wall-clock
 * duration rather than keeping the literal day-count number run over weekly bars instead of daily:
 *   - System 1 entry: 20 trading days ~= 4 weeks   | exit: 10 trading days ~= 2 weeks
 *   - System 2 entry: 55 trading days ~= 11 weeks  | exit: 20 trading days ~= 4 weeks
 *   - N (ATR): 20 trading days ~= 4 weeks -- the original system used the same ~1-month window
 *     for both the System 1 channel and N, so this rescaling stays faithful to that overlap.
 *
 * Deliberately NOT implemented: pyramiding (adding units as price moves in your favor) and the 2N
 * stop-loss. Both are inherently *stateful* trade-management rules -- they need to know an actual
 * open position's entry price and unit count over time, which requires real position/holdings
 * tracking that doesn't exist anywhere in this app (same gap lib/position-sizing.ts's doc comment
 * already flags). Building a half-implementation without real position state would be worse than
 * not building it; this module stays a point-in-time signal + suggested entry size, like everything
 * else in this pipeline.
 */

export const SYSTEM1_ENTRY_WEEKS = 4;
export const SYSTEM1_EXIT_WEEKS = 2;
export const SYSTEM2_ENTRY_WEEKS = 11;
export const SYSTEM2_EXIT_WEEKS = 4;
export const ATR_WEEKS = 4;

export interface WeeklyBar {
  high: number;
  low: number;
  close: number;
}

export interface DonchianSystem {
  entryHigh: number; // breakout-long level: prior entryWeeks' high
  entryLow: number; // breakout-short level: prior entryWeeks' low
  exitHigh: number; // trailing stop level for a short position: prior exitWeeks' high
  exitLow: number; // trailing stop level for a long position: prior exitWeeks' low
  breakoutLong: boolean; // latest close > entryHigh
  breakoutShort: boolean; // latest close < entryLow
}

/** `bars` ordered oldest -> newest. Channel levels are computed from the bars *before* the latest
 *  one -- a breakout compares today's close against prior history, not against itself. null when
 *  there isn't enough history for the wider of the two windows. */
export function computeDonchianSystem(bars: WeeklyBar[], entryWeeks: number, exitWeeks: number): DonchianSystem | null {
  const lookback = Math.max(entryWeeks, exitWeeks);
  if (bars.length < lookback + 1) return null;

  const latest = bars[bars.length - 1];
  const priorForEntry = bars.slice(-1 - entryWeeks, -1);
  const priorForExit = bars.slice(-1 - exitWeeks, -1);

  const entryHigh = Math.max(...priorForEntry.map((b) => b.high));
  const entryLow = Math.min(...priorForEntry.map((b) => b.low));
  const exitHigh = Math.max(...priorForExit.map((b) => b.high));
  const exitLow = Math.min(...priorForExit.map((b) => b.low));

  return {
    entryHigh,
    entryLow,
    exitHigh,
    exitLow,
    breakoutLong: latest.close > entryHigh,
    breakoutShort: latest.close < entryLow,
  };
}

export interface TurtleSignal {
  system1: DonchianSystem | null;
  system2: DonchianSystem | null;
  // Ensemble (Simons-inspired: combine signals rather than trust one) -- "confirmed" when both the
  // short and long system agree on direction, a stronger signal than either alone.
  confirmedLong: boolean;
  confirmedShort: boolean;
}

export function computeTurtleSignal(bars: WeeklyBar[]): TurtleSignal {
  const system1 = computeDonchianSystem(bars, SYSTEM1_ENTRY_WEEKS, SYSTEM1_EXIT_WEEKS);
  const system2 = computeDonchianSystem(bars, SYSTEM2_ENTRY_WEEKS, SYSTEM2_EXIT_WEEKS);
  return {
    system1,
    system2,
    confirmedLong: !!(system1?.breakoutLong && system2?.breakoutLong),
    confirmedShort: !!(system1?.breakoutShort && system2?.breakoutShort),
  };
}

/** Wilder's smoothing (the standard ATR method, not a plain moving average): seed with a simple
 *  average of the first `period` true ranges, then exponentially smooth the rest. True Range needs
 *  the *previous* bar's close, so this needs one more bar than `period` alone would suggest. */
export function computeATR(bars: WeeklyBar[], period: number): number | null {
  if (bars.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prevClose = bars[i - 1].close;
    trueRanges.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)));
  }
  if (trueRanges.length < period) return null;

  let atr = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

export const TURTLE_RISK_PER_UNIT_PCT = 1; // Turtle's own rule: risk 1% of capital per unit
export const TURTLE_MIN_WEIGHT_PCT = 2;
export const TURTLE_MAX_WEIGHT_PCT = 15; // same concentration cap as lib/position-sizing.ts, for consistency across the two sizing lenses

export interface TurtleSizeResult {
  suggestedWeightPct: number;
  n: number; // ATR in price units -- Turtle's "N"
}

/**
 * Turtle's Unit sizing, re-derived as a %-of-capital weight instead of a literal share count: this
 * app has no $ account size to size shares against (same constraint lib/position-sizing.ts already
 * documents). Turtle's own rule: Unit (shares) = (1% x Capital) / N, so that N x Unit (the risk if
 * price moves one N against you) equals 1% of Capital. Position value = Unit x Price, so as a
 * fraction of Capital that's (1% x Price) / N -- independent of an assumed capital figure, and
 * directionally consistent with lib/position-sizing.ts's inverse-volatility approach (larger N
 * relative to price -> smaller suggested weight), just derived from Turtle's own risk-per-unit rule
 * instead of a volatility-target anchor.
 */
export function suggestTurtleWeight(price: number, n: number | null): TurtleSizeResult | null {
  if (n == null || n <= 0 || price <= 0) return null;
  const raw = (TURTLE_RISK_PER_UNIT_PCT * price) / n;
  const suggestedWeightPct = Math.min(TURTLE_MAX_WEIGHT_PCT, Math.max(TURTLE_MIN_WEIGHT_PCT, raw));
  return { suggestedWeightPct, n };
}
