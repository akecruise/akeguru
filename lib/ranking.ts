import { z } from "zod";

// Ported from stocklens's IDS ranking (fundamental 50% / momentum 30% / sentiment 20%),
// reimplemented here as a pure weighted blend over scores the refresh job already computes —
// no new schema. Sentiment stays at a fixed 0 weight (see rankingWeightsSchema) until a real
// sentiment data source is chosen; fabricating one would be worse than omitting it.

export interface RankingWeights {
  fundamental: number;
  momentum: number;
  sentiment?: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = { fundamental: 50, momentum: 30, sentiment: 0 };

export const rankingWeightsSchema = z.object({
  fundamental: z.coerce.number().min(0).max(100).default(DEFAULT_RANKING_WEIGHTS.fundamental),
  momentum: z.coerce.number().min(0).max(100).default(DEFAULT_RANKING_WEIGHTS.momentum),
  // Not exposed in the UI yet — no sentiment data source exists. Accepted here only so the
  // shape doesn't need to change again once one does.
  sentiment: z.coerce.number().min(0).max(100).default(0),
});

export interface RankableStock {
  id: string;
  latestOverallScore: number | null; // 0-100 (Snowflake overall)
  latestMomentumScore: number | null; // 0-5
}

export interface RankedStock<T extends RankableStock> {
  stock: T;
  rankScore: number | null;
  fundamentalContribution: number; // 0-100, before weighting
  momentumContribution: number; // 0-100, before weighting
}

/**
 * Weighted blend over already-computed scores — no percentile math here (that's scoring.ts's
 * job). Weights don't need to sum to 100; they're normalized against their own total. A stock
 * missing a component (e.g. momentum not yet scored) gets 0 credit for that component rather
 * than being excluded — consistent with how a missing dividend is treated as "no data = no
 * credit" elsewhere, not "skip this factor."
 */
export function rankStocks<T extends RankableStock>(
  stocks: T[],
  weights: RankingWeights,
): RankedStock<T>[] {
  const sentimentWeight = weights.sentiment ?? 0;
  const totalWeight = weights.fundamental + weights.momentum + sentimentWeight;

  const ranked = stocks.map((stock) => {
    const fundamentalContribution = stock.latestOverallScore ?? 0;
    const momentumContribution = stock.latestMomentumScore != null ? (stock.latestMomentumScore / 5) * 100 : 0;
    const rankScore =
      totalWeight > 0
        ? (weights.fundamental * fundamentalContribution + weights.momentum * momentumContribution) / totalWeight
        : null;
    return { stock, rankScore, fundamentalContribution, momentumContribution };
  });

  ranked.sort((a, b) => (b.rankScore ?? -Infinity) - (a.rankScore ?? -Infinity));
  return ranked;
}
