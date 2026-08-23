/**
 * Thesis Momentum Score (Phase 4 roadmap item, "from diff history"). Pure, DB-free trend
 * computation (same reasoning as lib/regime.ts) — scripts/thesis-momentum.ts supplies a ticker's
 * ResearchReport history ordered by dataAsOf.
 *
 * Diffs decision (NO_GO -> WAIT -> GO, ranked -1/0/+1) and conviction (1-5) between the earliest
 * and latest report only -- not a full pairwise diff of every consecutive pair, and not the thesis
 * *text* itself (a real semantic diff of prose is a much bigger undertaking than this scope
 * warrants right now; decision+conviction are the two fields every report already has in a
 * directly comparable numeric form). "Improving"/"deteriorating" describes the trajectory across
 * whatever history exists, not a claim about why it moved.
 */

export type DecisionValue = "GO" | "WAIT" | "NO_GO";
const DECISION_RANK: Record<DecisionValue, number> = { NO_GO: -1, WAIT: 0, GO: 1 };

export interface ThesisSnapshot {
  dataAsOf: Date;
  decision: DecisionValue;
  conviction: number; // 1-5
}

export type Trend = "improving" | "deteriorating" | "stable";

export interface ThesisMomentumResult {
  decisionTrend: Trend;
  convictionTrend: Trend;
  momentumScore: number; // -1 (deteriorating) .. +1 (improving), combines both
  first: ThesisSnapshot;
  last: ThesisSnapshot;
  snapshotCount: number;
}

/** Needs >= 2 reports to have a trend at all -- a single snapshot has nothing to diff against. */
export function computeThesisMomentum(history: ThesisSnapshot[]): ThesisMomentumResult | null {
  if (history.length < 2) return null;

  const sorted = [...history].sort((a, b) => a.dataAsOf.getTime() - b.dataAsOf.getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const decisionDelta = DECISION_RANK[last.decision] - DECISION_RANK[first.decision]; // -2..+2
  const convictionDelta = last.conviction - first.conviction; // -4..+4

  const trendOf = (delta: number): Trend => (delta > 0 ? "improving" : delta < 0 ? "deteriorating" : "stable");

  // Both deltas normalized to -1..1 first (their own max range), then averaged -- so a full swing
  // on either dimension alone (NO_GO->GO with flat conviction, or 1->5 conviction with flat
  // decision) contributes the same weight to the combined score.
  const momentumScore = (decisionDelta / 2 + convictionDelta / 4) / 2;

  return {
    decisionTrend: trendOf(decisionDelta),
    convictionTrend: trendOf(convictionDelta),
    momentumScore,
    first,
    last,
    snapshotCount: sorted.length,
  };
}
