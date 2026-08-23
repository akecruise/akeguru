/**
 * Gate 1 (fact) — every Fundamentals metric that has a value cites a real, correctly-valued
 * FinancialFact row. Reuses checkGrounding() (lib/agents/grounding.ts) rather than
 * reimplementing the same three checks it already runs exhaustively (factId exists, value
 * matches, metricName plausibly matches) — see gate2-consistency.ts for the equivalent check over
 * the narrative-text sections, which checkGrounding doesn't cover.
 */
import { checkGrounding, type RealFact } from "../agents/grounding";
import type { StockReport } from "../report/types";
import type { GateOutcome } from "./types";

export function gate1Fact(report: StockReport, realFacts: RealFact[]): GateOutcome {
  const result = checkGrounding(report.fundamentals, realFacts);
  return {
    gateNumber: 1,
    gateName: "fact",
    passed: result.ok,
    notes: { checkedCount: result.checkedCount, issues: result.issues },
  };
}
