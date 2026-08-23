/**
 * Builds the "estimates" section — consensus-only (no LLM "own" forecast; see docs/eval, the
 * design call that motivated this was: turning FinancialFact consensus rows into EstimateBlock[]
 * is pure mechanical reshaping with zero judgment involved, so it's a deterministic function, not
 * an agent — no prompt, no zod-retry loop, no grounding check, no hallucination risk to check for.
 *
 * Source facts come from lib/data/input-sources/router.ts's mapYahooEarningsTrendFacts(), written
 * by scripts/ingest.ts alongside the rest of a ticker's FinancialFact rows. Yahoo's earningsTrend
 * only ever has revenue/EPS consensus (no ebitda/fcf estimates exist anywhere in that data), no
 * stdDev, and no historical-actuals module — so those gaps are real, not an oversight here:
 *   - only 'revenue'/'eps' blocks are ever produced (no 'ebitda'/'fcf' — see EstimateBlock.metric)
 *   - consensus.stdDev, actual, beatMissPct, divergencePct are always null/all-null — no source
 *   - own is always null (that's the "consensus-only" part)
 */
import type { EstimateBlock } from "./types";

interface ConsensusFact {
  metricName: string;
  value: number;
  period: string;
}

const METRIC_PREFIXES = {
  revenue: "Revenue Estimate",
  eps: "EPS Estimate",
} as const;

const MIN_ANALYSTS_FOR_COVERAGE = 3;

function lookup(facts: ConsensusFact[], prefix: string, suffix: string, period: string): number | null {
  const f = facts.find((f) => f.metricName === `${prefix} (${suffix})` && f.period === period);
  return f ? f.value : null;
}

/**
 * Exhaustive over 'revenue'/'eps' — the only two metrics Yahoo's earningsTrend ever covers. A
 * metric with no matching facts at all is simply omitted (not emitted as an all-null block), since
 * EstimateBlockSchema requires consensus-or-own to be non-null and there'd be neither.
 */
export function buildConsensusEstimates(allFacts: ConsensusFact[]): EstimateBlock[] {
  const blocks: EstimateBlock[] = [];

  for (const metric of Object.keys(METRIC_PREFIXES) as (keyof typeof METRIC_PREFIXES)[]) {
    const prefix = METRIC_PREFIXES[metric];
    const relevant = allFacts.filter((f) => f.metricName.startsWith(`${prefix} (`));
    if (!relevant.length) continue;

    const periods = [...new Set(relevant.map((f) => f.period))].sort(); // ISO dates -> chronological

    const numEstimates = periods.map((p) => lookup(relevant, prefix, "# Analysts", p));
    blocks.push({
      metric,
      periods,
      consensus: {
        mean: periods.map((p) => lookup(relevant, prefix, "Avg", p)),
        high: periods.map((p) => lookup(relevant, prefix, "High", p)),
        low: periods.map((p) => lookup(relevant, prefix, "Low", p)),
        stdDev: periods.map(() => null),
        numEstimates,
        lowCoverage: numEstimates.some((n) => n !== null && n < MIN_ANALYSTS_FOR_COVERAGE),
      },
      own: null,
      actual: periods.map(() => null),
      beatMissPct: periods.map(() => null),
      divergencePct: null,
    });
  }

  return blocks;
}
