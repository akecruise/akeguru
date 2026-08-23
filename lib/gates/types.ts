/** One gate's verdict, before the rigor/reviewedBy stamp gets added by runGates() (see index.ts) —
 *  rigor is a property of what source data exists for the ticker, not of any individual gate. */
export interface GateOutcome {
  gateNumber: number;
  gateName: string;
  passed: boolean;
  notes: Record<string, unknown>;
}
