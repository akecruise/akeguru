/**
 * Gate 4 (freshness) — ResearchReport.dataAsOf must be within the last 6 months. Takes the DB
 * column directly (not payload.meta.dataAsOf) since it's the canonical value the schema comment
 * calls out for this check, and doesn't depend on the JSON payload's shape staying correct.
 */
import type { GateOutcome } from "./types";

const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;

export function gate4Freshness(dataAsOf: Date, now: Date = new Date()): GateOutcome {
  const ageMs = now.getTime() - dataAsOf.getTime();
  const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
  const passed = !Number.isNaN(dataAsOf.getTime()) && ageMs >= 0 && ageMs <= SIX_MONTHS_MS;

  return {
    gateNumber: 4,
    gateName: "freshness",
    passed,
    notes: { dataAsOf: dataAsOf.toISOString(), ageDays, maxAgeDays: 183 },
  };
}
