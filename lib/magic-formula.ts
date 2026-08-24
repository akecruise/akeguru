/**
 * Magic Formula (Joel Greenblatt, "The Little Book That Beats the Market") -- ranks stocks on two
 * axes, quality and cheapness, and combines the two ranks (lower combined rank = better). This is a
 * PROXY version, not literal Greenblatt: the real formula ranks ROIC (NOPAT / invested capital) and
 * Earnings Yield (EBIT / EV). Neither NOPAT/invested-capital nor a standalone EBIT figure exists
 * anywhere in this pipeline -- Yahoo's quoteSummary modules this app ingests (lib/yahoo.ts) don't
 * expose them. Rather than fabricate EBIT or invested capital from figures that don't actually
 * decompose to them, this substitutes the closest fields already ingested:
 *
 *   - quality: ROA (Stock.roa) instead of ROIC -- after-tax and asset-based rather than pre-tax /
 *     invested-capital-based, but still far less leverage-distorted than ROE, which is exactly the
 *     distortion Greenblatt's ROIC choice exists to avoid (a highly-levered company can post a high
 *     ROE without being a genuinely efficient business).
 *   - cheapness: EBITDA/EV, i.e. 1 / Stock.evToEbitda, instead of EBIT/EV -- Yahoo only exposes the
 *     EV/EBITDA *ratio* itself (enterpriseToEbitda), not a standalone EBIT or absolute EV figure.
 *
 * Both are documented, revisitable proxies, not a claim of parity with the original formula --
 * hence "Magic-Formula-style" in any user-facing label, not "Magic Formula."
 */

export interface MagicFormulaInput {
  id: string;
  roa: number | null;
  evToEbitda: number | null;
}

export interface MagicFormulaRank {
  id: string;
  qualityRank: number; // 1 = best (highest ROA)
  cheapnessRank: number; // 1 = best (highest EBITDA/EV, i.e. lowest EV/EBITDA)
  combinedRank: number; // qualityRank + cheapnessRank -- Greenblatt's own combination method; lower is better
}

/** Excludes anything missing ROA or with a non-positive EV/EBITDA -- a negative EBITDA makes the
 *  ratio meaningless (it would rank as "cheap" for the wrong reason: negative earnings, not a low
 *  price), not a real cheapness signal. */
export function rankMagicFormula(inputs: MagicFormulaInput[]): MagicFormulaRank[] {
  const withData = inputs.filter((i) => i.roa != null && i.evToEbitda != null && i.evToEbitda > 0);

  const byQuality = [...withData].sort((a, b) => b.roa! - a.roa!);
  const qualityRankById = new Map(byQuality.map((s, i) => [s.id, i + 1]));

  const byCheapness = [...withData].sort((a, b) => a.evToEbitda! - b.evToEbitda!);
  const cheapnessRankById = new Map(byCheapness.map((s, i) => [s.id, i + 1]));

  return withData
    .map((i) => {
      const qualityRank = qualityRankById.get(i.id)!;
      const cheapnessRank = cheapnessRankById.get(i.id)!;
      return { id: i.id, qualityRank, cheapnessRank, combinedRank: qualityRank + cheapnessRank };
    })
    .sort((a, b) => a.combinedRank - b.combinedRank);
}
