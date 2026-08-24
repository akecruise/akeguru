/**
 * Neff Total Return Ratio (John Neff, "John Neff on Investing") -- (earnings growth + dividend
 * yield) / P/E, a simple quant screen for "cheap growth with a dividend cushion." Neff's own
 * stated threshold: > 2 is attractive. Pure, DB-free (same reasoning as lib/lynch.ts) -- every
 * input already exists on Stock, no new ingestion needed.
 *
 * Uses Stock.estEarningsGrowth (analyst consensus, sparse for TH tickers -- see that field's own
 * doc comment) rather than trailing growth, since Neff's ratio is forward-looking by design: paying
 * today's P/E for tomorrow's growth.
 */

export const NEFF_ATTRACTIVE_THRESHOLD = 2; // Neff's own stated "attractive" cutoff

/** null when P/E isn't a real earnings multiple (missing or <= 0 -- a loss-making company has no
 *  P/E to divide by, and the ratio would invert sign misleadingly rather than mean anything) or
 *  growth estimate is unavailable. estEarningsGrowth/dividendYield are stored as fractions (0.20 =
 *  20%) -- Neff's ratio conventionally uses whole-number percentages, so both are scaled by 100
 *  before dividing. dividendYield null (true "unknown," see Stock's own doc comment distinguishing
 *  it from a confirmed 0) is treated as 0 here -- undercounting a possibly-real yield we just don't
 *  have, rather than fabricating one. */
export function computeNeffRatio(
  estEarningsGrowth: number | null,
  dividendYield: number | null,
  peRatio: number | null,
): number | null {
  if (estEarningsGrowth == null || peRatio == null || peRatio <= 0) return null;
  const dividendPct = (dividendYield ?? 0) * 100;
  return (estEarningsGrowth * 100 + dividendPct) / peRatio;
}
