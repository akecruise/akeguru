/**
 * Toplist consensus (scripts/toplist.ts) -- blends this app's several independent scoring lenses
 * (Snowflake composite, momentum, Magic Formula-style, Neff ratio, Lynch PEG, Turtle confirmation)
 * into one ranked "consensus" per stock, each lens given a trustWeight.
 *
 * Every lens has a different native scale (0-100, 0-5, an ordinal rank, an unbounded ratio) so they
 * can't be averaged directly -- each is first converted to a percentile (0-100, "beats X% of the
 * scored universe on this lens") using the same percentileOf() approach lib/scoring.ts already uses
 * for the Snowflake dimensions, then blended as a weighted average of percentiles.
 *
 * A stock missing a lens (no PEG, no ResearchReport for Turtle, insufficient data for Magic
 * Formula/Neff) has that lens *omitted*, not defaulted to 0 or the cohort average -- the remaining
 * weights are renormalized against just the lenses that actually have data for that stock, so
 * lacking one input never silently drags a stock's consensus down for a reason unrelated to its
 * actual merit.
 */
import { rankMagicFormula } from "./magic-formula";
import { computeNeffRatio } from "./neff";

export type ConsensusMethod = "snowflake" | "momentum" | "magicFormula" | "neff" | "lynchPeg" | "turtle";

export type TrustWeights = Record<ConsensusMethod, number>;

// Defaults, not a claim of optimality -- reasoning per lens:
//   snowflake (0.30)   -- most complete lens (5 fundamental dimensions + liquidity discount already applied)
//   momentum  (0.15)   -- real price-trend signal, but a single dimension on its own
//   magicFormula (0.20)-- a real, if proxied (see lib/magic-formula.ts), quality+cheapness combination
//   neff (0.15)        -- growth+yield/PE -- a real formula, but PEG-style ratios are known to
//                         misread turnaround stocks (same caveat lib/lynch.ts documents)
//   lynchPeg (0.10)    -- valuation-vs-growth lens, smaller weight since it's one ratio
//   turtle (0.10)      -- explicitly a technical/momentum confirmation, not fundamental -- kept
//                         smallest on purpose, matching orchestrator.ts's own "never substitute for
//                         MOS/moat/risk" framing for this exact signal
export const DEFAULT_TRUST_WEIGHTS: TrustWeights = {
  snowflake: 0.3,
  momentum: 0.15,
  magicFormula: 0.2,
  neff: 0.15,
  lynchPeg: 0.1,
  turtle: 0.1,
};

export interface ConsensusInput {
  id: string;
  latestOverallScore: number | null; // 0-100
  latestMomentumScore: number | null; // 0-5
  roa: number | null;
  evToEbitda: number | null;
  estEarningsGrowth: number | null;
  dividendYield: number | null;
  peRatio: number | null;
  pegRatio: number | null;
  turtleConfirmed: "long" | "short" | "none" | null; // null = no ResearchReport/turtle data at all
}

export interface ConsensusResult {
  id: string;
  consensusScore: number | null; // 0-100, null only if every lens was unavailable
  methodPercentiles: Partial<Record<ConsensusMethod, number>>;
}

/** Share of `sorted` at or below `value`, in [0, 100] -- same definition as lib/scoring.ts's percentileOf. */
function percentileOf(value: number, sorted: number[]): number {
  let count = 0;
  for (const v of sorted) if (v <= value) count++;
  return (count / sorted.length) * 100;
}

/** Builds an id -> percentile map for one numeric lens, skipping nulls entirely (they get no
 *  entry, not a 0). `higherIsBetter=false` flips the ranking (e.g. a lower PEG is better). */
function percentileMap(ids: string[], values: (number | null)[], higherIsBetter: boolean): Map<string, number> {
  const pairs = ids.map((id, i) => ({ id, v: values[i] })).filter((p): p is { id: string; v: number } => p.v != null);
  const oriented = pairs.map((p) => (higherIsBetter ? p.v : -p.v));
  const sorted = [...oriented].sort((a, b) => a - b);
  const map = new Map<string, number>();
  pairs.forEach((p, i) => map.set(p.id, percentileOf(oriented[i], sorted)));
  return map;
}

export function computeConsensus(inputs: ConsensusInput[], weights: TrustWeights = DEFAULT_TRUST_WEIGHTS): ConsensusResult[] {
  const ids = inputs.map((i) => i.id);

  const snowflakeMap = percentileMap(ids, inputs.map((i) => i.latestOverallScore), true);
  const momentumMap = percentileMap(ids, inputs.map((i) => i.latestMomentumScore), true);

  const mfRanks = rankMagicFormula(inputs.map((i) => ({ id: i.id, roa: i.roa, evToEbitda: i.evToEbitda })));
  // combinedRank: lower is better -- negate before percentile-ranking so "higher is better" holds uniformly.
  const magicFormulaMap = percentileMap(mfRanks.map((r) => r.id), mfRanks.map((r) => -r.combinedRank), true);

  const neffValues = inputs.map((i) => computeNeffRatio(i.estEarningsGrowth, i.dividendYield, i.peRatio));
  const neffMap = percentileMap(ids, neffValues, true);

  const pegMap = percentileMap(ids, inputs.map((i) => i.pegRatio), false); // lower PEG = better

  const turtleMap = new Map<string, number>();
  for (const i of inputs) {
    if (i.turtleConfirmed === "long") turtleMap.set(i.id, 100);
    else if (i.turtleConfirmed === "none") turtleMap.set(i.id, 50);
    else if (i.turtleConfirmed === "short") turtleMap.set(i.id, 0);
    // null (no report at all) -> no entry, lens omitted for this stock
  }

  const lensMaps: Record<ConsensusMethod, Map<string, number>> = {
    snowflake: snowflakeMap,
    momentum: momentumMap,
    magicFormula: magicFormulaMap,
    neff: neffMap,
    lynchPeg: pegMap,
    turtle: turtleMap,
  };

  return inputs.map((i) => {
    const methodPercentiles: Partial<Record<ConsensusMethod, number>> = {};
    let weightedSum = 0;
    let totalWeight = 0;
    for (const method of Object.keys(lensMaps) as ConsensusMethod[]) {
      const pct = lensMaps[method].get(i.id);
      if (pct == null) continue;
      methodPercentiles[method] = pct;
      weightedSum += weights[method] * pct;
      totalWeight += weights[method];
    }
    return {
      id: i.id,
      consensusScore: totalWeight > 0 ? weightedSum / totalWeight : null,
      methodPercentiles,
    };
  });
}
