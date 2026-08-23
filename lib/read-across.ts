/**
 * Read-Across Engine (Phase 4 roadmap item, "fact changes -> rerun related tickers in the graph").
 * Pure, DB-free change detection (same reasoning as lib/regime.ts) -- scripts/read-across.ts
 * supplies the before/after values and does the CompanyRelation graph walk (lib/company-relation.ts,
 * the same one scripts/theme-pipeline.ts uses).
 *
 * KEY_METRICS is a fixed, curated list, not "every FinancialFact metricName" -- a change in e.g.
 * Market Cap is just the stock price moving, not a fact worth propagating through the relation
 * graph; these are the metrics that plausibly indicate a real change to the business (growth,
 * profitability, financial health) rather than daily price noise.
 */

export const KEY_METRICS = [
  "Revenue",
  "FCF",
  "CFO",
  "Debt/Equity",
  "Revenue Estimate (Avg)",
  "EPS Estimate (Avg)",
] as const;

export const MATERIAL_CHANGE_THRESHOLD_PCT = 10; // relative change -- a documented, revisitable assumption, not a validated model (same posture as lib/regime.ts's breadth thresholds)

export interface MetricChange {
  metricName: string;
  oldValue: number;
  newValue: number;
  changePct: number; // signed, percentage points (e.g. -15.2 for a 15.2% decrease)
}

/** `oldValues`/`newValues`: keyed by KEY_METRICS entries -- a metric missing from either side (no
 *  fact at that point in time) is skipped, not treated as a 0 -> value change. A zero old value is
 *  also skipped -- percentage change from zero is undefined, not a real "material change" signal. */
export function detectMaterialChanges(
  oldValues: Partial<Record<(typeof KEY_METRICS)[number], number | null>>,
  newValues: Partial<Record<(typeof KEY_METRICS)[number], number | null>>,
): MetricChange[] {
  const changes: MetricChange[] = [];
  for (const metricName of KEY_METRICS) {
    const oldValue = oldValues[metricName];
    const newValue = newValues[metricName];
    if (oldValue == null || newValue == null || oldValue === 0) continue;

    const changePct = ((newValue - oldValue) / Math.abs(oldValue)) * 100;
    if (Math.abs(changePct) >= MATERIAL_CHANGE_THRESHOLD_PCT) {
      changes.push({ metricName, oldValue, newValue, changePct });
    }
  }
  return changes;
}
