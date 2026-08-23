/**
 * Gate 7 (sector-metrics) — checks whether the report's *interpretive* sections (riskFactors,
 * bulls/bears) actually rely on a metric lib/sector-profile.ts forbids for the ticker's sector
 * (e.g. citing EV/EBITDA as evidence for a bank, or trailing P/E for a distressed/cyclical name at
 * cycle peak).
 *
 * Deliberately checks citations, not lib/report/types.ts's Fundamentals section directly --
 * confirmed live this matters: valuation.md is a pure, exhaustive fact-transcriber by design (its
 * own rule 6: copy every real metric, judge nothing), so a forbidden metric like P/B shows up with
 * a real value in *every* tech report's Fundamentals regardless of whether anyone actually used it
 * to draw a conclusion -- checking presence-in-Fundamentals there made Gate 7 fail MSFT's real
 * report for literally listing P/B, which is exactly the false-positive this gate should not
 * produce. Checking what riskFactors/bulls/bears actually *cite* as evidence is the right signal:
 * that's where a metric gets used to support a conclusion, not just recorded.
 *
 * moat/businessSummary/growthDrivers are out of scope -- sectorGuidance (lib/report/orchestrator.ts)
 * is only given to risk.md and synthesis.md, the two agents that draw valuation-relevant
 * conclusions; this gate checks exactly those same sections.
 *
 * Only checks forbiddenMetrics, not sector-profile.ts's primaryValuation requirement (a sector must
 * use >=1 of its primary metrics) -- several sectors' primary metrics aren't ingested anywhere in
 * this pipeline at all (real_estate's P/FFO and P/AFFO need an FFO figure this app never fetches),
 * so enforcing that half automatically would fail every report in those sectors for a data gap, not
 * an agent error. METRIC_NAME_TO_SECTOR_ID only covers the FinancialFact-backed metrics that
 * actually exist in Fundamentals today; a metric this codebase doesn't track can't be flagged
 * either way.
 *
 * Sector unmapped (unknown Yahoo sector string, or sector null) skips this gate (passed: true) --
 * same "can't check what we can't classify" reasoning as gate6Nena.
 */
import { normalizeSector, getSectorProfile } from "../sector-profile";
import type { RealFact } from "../agents/grounding";
import type { StockReport } from "../report/types";
import type { GateOutcome } from "./types";

const METRIC_NAME_TO_SECTOR_ID: Record<string, string> = {
  "P/E": "pe_trailing",
  "P/B": "pb",
  "EV/EBITDA": "ev_ebitda",
  "EV/Sales": "ev_sales",
  "ROE": "roe",
  "Dividend Yield": "div_yield",
  "Earnings Growth": "eps_growth",
};

function skip(reason: string): GateOutcome {
  return { gateNumber: 7, gateName: "sector-metrics", passed: true, notes: { skipped: reason } };
}

export function gate7SectorMetrics(report: StockReport, rawSector: string | null, citedFacts: RealFact[]): GateOutcome {
  if (!rawSector) return skip("no sector on record");

  let sector;
  try {
    sector = normalizeSector(rawSector);
  } catch {
    return skip(`unmapped sector "${rawSector}"`);
  }

  const profile = getSectorProfile(sector);
  const factById = new Map(citedFacts.map((f) => [f.id, f]));

  const interpretiveFactIds = new Set<string>();
  for (const b of report.riskFactors) for (const id of b.supportingFactIds) interpretiveFactIds.add(id);
  for (const c of [...report.bulls, ...report.bears]) for (const id of c.supportingFactIds) interpretiveFactIds.add(id);

  const violationIds = new Set<string>();
  for (const factId of interpretiveFactIds) {
    const fact = factById.get(factId);
    if (!fact) continue; // an unresolvable factId is Gate 1/2's job, not this one
    const sectorMetricId = METRIC_NAME_TO_SECTOR_ID[fact.metricName];
    if (sectorMetricId) violationIds.add(sectorMetricId);
  }

  const violations = profile.forbiddenMetrics.filter((f) => violationIds.has(f.id));

  return {
    gateNumber: 7,
    gateName: "sector-metrics",
    passed: violations.length === 0,
    notes: { sector, violations },
  };
}
