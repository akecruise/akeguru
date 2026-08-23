/**
 * Gate 2 (consistency) — every financial-looking number written in narrative text (riskFactors,
 * growthDrivers, moat, businessSummary, bulls, bears) is within ±5% of a real FinancialFact among
 * that item's supportingFactIds, and every supportingFactIds entry actually exists. Reuses
 * checkBulletGrounding/checkMoatGrounding/checkClaimGrounding (lib/agents/grounding.ts) — the same
 * checks docs/eval/*.md already validated by hand per agent — run together over the persisted
 * payload instead of one agent's raw output. Fundamentals itself is Gate 1's job, not this one.
 *
 * Also checks verdict.invalidationTriggers (Phase 2 — checkInvalidationTriggers): each trigger's
 * metricName has to be a real FinancialFact this ticker actually has, same "don't cite something
 * that doesn't exist" principle as everything else here, just checking a metric name instead of a
 * factId (a trigger watches a metric going forward, not a specific historical fact row).
 */
import { checkBulletGrounding, checkMoatGrounding, checkClaimGrounding, checkInvalidationTriggers, type RealFact } from "../agents/grounding";
import type { StockReport } from "../report/types";
import type { GateOutcome } from "./types";

export function gate2Consistency(report: StockReport, realFacts: RealFact[]): GateOutcome {
  const triggersResult = checkInvalidationTriggers(report.verdict.invalidationTriggers, realFacts);

  const sections: Record<string, { ok: boolean; checkedCount: number; issues: Array<{ title: string; reason: string; detail: string }> }> = {
    riskFactors: checkBulletGrounding(report.riskFactors, realFacts),
    growthDrivers: checkBulletGrounding(report.growthDrivers, realFacts),
    moat: checkMoatGrounding(report.moat, realFacts),
    businessSummary: checkClaimGrounding(report.businessSummary, realFacts),
    bulls: checkClaimGrounding(report.bulls, realFacts),
    bears: checkClaimGrounding(report.bears, realFacts),
    invalidationTriggers: {
      ok: triggersResult.ok,
      checkedCount: triggersResult.checkedCount,
      issues: triggersResult.issues.map((i) => ({ title: i.description, reason: i.reason, detail: i.detail })),
    },
  };

  const issues = Object.entries(sections).flatMap(([section, r]) => r.issues.map((i) => ({ section, ...i })));
  const checkedCount = Object.values(sections).reduce((sum, r) => sum + r.checkedCount, 0);

  return {
    gateNumber: 2,
    gateName: "consistency",
    passed: issues.length === 0,
    notes: { checkedCount, issues },
  };
}
