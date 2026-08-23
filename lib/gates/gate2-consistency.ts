/**
 * Gate 2 (consistency) — every financial-looking number written in narrative text (riskFactors,
 * growthDrivers, moat, businessSummary, bulls, bears) is within ±5% of a real FinancialFact among
 * that item's supportingFactIds, and every supportingFactIds entry actually exists. Reuses
 * checkBulletGrounding/checkMoatGrounding/checkClaimGrounding (lib/agents/grounding.ts) — the same
 * checks docs/eval/*.md already validated by hand per agent — run together over the persisted
 * payload instead of one agent's raw output. Fundamentals itself is Gate 1's job, not this one.
 */
import { checkBulletGrounding, checkMoatGrounding, checkClaimGrounding, type RealFact, type BulletGroundingIssue } from "../agents/grounding";
import type { StockReport } from "../report/types";
import type { GateOutcome } from "./types";

export function gate2Consistency(report: StockReport, realFacts: RealFact[]): GateOutcome {
  const sections: Record<string, { ok: boolean; checkedCount: number; issues: BulletGroundingIssue[] }> = {
    riskFactors: checkBulletGrounding(report.riskFactors, realFacts),
    growthDrivers: checkBulletGrounding(report.growthDrivers, realFacts),
    moat: checkMoatGrounding(report.moat, realFacts),
    businessSummary: checkClaimGrounding(report.businessSummary, realFacts),
    bulls: checkClaimGrounding(report.bulls, realFacts),
    bears: checkClaimGrounding(report.bears, realFacts),
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
