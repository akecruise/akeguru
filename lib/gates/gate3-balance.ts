/**
 * Gate 3 (balance) — bulls and bears must each have >=2 items. StockReportSchema already enforces
 * this at generation time (lib/report/schema.ts's SynthesisSchema), but ResearchReport.payload is
 * stored as untyped Json — this independently rechecks the persisted row rather than trusting that
 * whatever wrote it upheld the invariant (schema versions drift, and nothing stops a manual edit).
 */
import type { StockReport } from "../report/types";
import type { GateOutcome } from "./types";

const MIN_PER_SIDE = 2;

export function gate3Balance(report: StockReport): GateOutcome {
  const bulls = report.bulls?.length ?? 0;
  const bears = report.bears?.length ?? 0;
  const passed = bulls >= MIN_PER_SIDE && bears >= MIN_PER_SIDE;

  return {
    gateNumber: 3,
    gateName: "balance",
    passed,
    notes: { bulls, bears, required: MIN_PER_SIDE },
  };
}
