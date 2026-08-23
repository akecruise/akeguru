/**
 * Gate 5 (completeness) — every section in REQUIRED_SECTIONS (lib/report/types.ts) is present and
 * non-empty on the persisted payload. Mirrors what validateReport() already enforces via zod at
 * generation time (see orchestrator.ts's comment calling validateReport "the completeness check
 * equivalent to Gate 5") but, like gate3-balance, rechecks the actual stored row instead of
 * trusting that whatever wrote it upheld the invariant.
 */
import { REQUIRED_SECTIONS, type StockReport } from "../report/types";
import type { GateOutcome } from "./types";

function isPresent(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function gate5Completeness(report: StockReport): GateOutcome {
  const missing = REQUIRED_SECTIONS.filter((section) => !isPresent(report[section]));

  return {
    gateNumber: 5,
    gateName: "completeness",
    passed: missing.length === 0,
    notes: { requiredSections: REQUIRED_SECTIONS, missing },
  };
}
