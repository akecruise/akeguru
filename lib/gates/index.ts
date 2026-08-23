/**
 * Runs Gate 1-7 (prisma/schema.prisma's QualityGateLog pipeline — previously unimplemented, see
 * lib/report/orchestrator.ts's header comment) against an already-saved ResearchReport, writes one
 * QualityGateLog row per gate, and sets ResearchReport.gateStatus to APPROVED (all 7 passed) or
 * REJECTED (any failed). Gate 7 (sector-metrics) is newer than the rest — added alongside
 * lib/sector-profile.ts, not part of the original Gate 1-6 design.
 *
 * rigor reflects how deep a code-only check can actually go for this ticker's market (GateRigor's
 * doc comment: "US has XBRL for a full check; HK/TH can only compare against Yahoo"): FULL when a
 * SEC RawSource exists, PARTIAL when only Yahoo does, MANUAL when neither structured source
 * exists. Stamped on every gate's log row, not just Gate 6 — it's a property of what data exists
 * for the ticker, not of any individual gate's own logic.
 */
import type { PrismaClient, Prisma } from "../../generated/prisma/client";
import type { StockReport } from "../report/types";
import { collectReportFactIds, type RealFact } from "../agents/grounding";
import { gate1Fact } from "./gate1-fact";
import { gate2Consistency } from "./gate2-consistency";
import { gate3Balance } from "./gate3-balance";
import { gate4Freshness } from "./gate4-freshness";
import { gate5Completeness } from "./gate5-completeness";
import { gate6Nena } from "./gate6-nena";
import { gate7SectorMetrics } from "./gate7-sector-metrics";
import type { GateOutcome } from "./types";

const GATE_FILES: Record<number, string> = {
  1: "gate1-fact.ts",
  2: "gate2-consistency.ts",
  3: "gate3-balance.ts",
  4: "gate4-freshness.ts",
  5: "gate5-completeness.ts",
  6: "gate6-nena.ts",
  7: "gate7-sector-metrics.ts",
};

export interface RunGatesResult {
  gateStatus: "APPROVED" | "REJECTED";
  rigor: "FULL" | "PARTIAL" | "MANUAL";
  outcomes: GateOutcome[];
}

export async function runGates(prisma: PrismaClient, reportId: string): Promise<RunGatesResult> {
  const report = await prisma.researchReport.findUniqueOrThrow({ where: { id: reportId } });
  const payload = report.payload as unknown as StockReport;

  const factIds = collectReportFactIds(payload);
  const citedFacts: RealFact[] = factIds.length
    ? await prisma.financialFact.findMany({ where: { id: { in: factIds } }, select: { id: true, metricName: true, value: true, unit: true } })
    : [];

  const [allFacts, rawSources, stock] = await Promise.all([
    prisma.financialFact.findMany({ where: { ticker: report.ticker } }),
    prisma.rawSource.findMany({ where: { ticker: report.ticker } }),
    prisma.stock.findUnique({ where: { ticker: report.ticker }, select: { sector: true } }),
  ]);

  const markets = new Set(rawSources.map((r) => r.market));
  const rigor: "FULL" | "PARTIAL" | "MANUAL" = markets.has("SEC") ? "FULL" : markets.has("YAHOO") ? "PARTIAL" : "MANUAL";

  const outcomes: GateOutcome[] = [
    gate1Fact(payload, citedFacts),
    gate2Consistency(payload, citedFacts),
    gate3Balance(payload),
    gate4Freshness(report.dataAsOf),
    gate5Completeness(payload),
    await gate6Nena(allFacts, rawSources),
    gate7SectorMetrics(payload, stock?.sector ?? null, citedFacts),
  ];

  const gateStatus = outcomes.every((o) => o.passed) ? "APPROVED" : "REJECTED";

  await prisma.$transaction([
    prisma.qualityGateLog.createMany({
      data: outcomes.map((o) => ({
        reportId,
        gateNumber: o.gateNumber,
        gateName: o.gateName,
        passed: o.passed,
        rigor,
        notes: o.notes as Prisma.InputJsonValue,
        reviewedBy: GATE_FILES[o.gateNumber],
      })),
    }),
    prisma.researchReport.update({ where: { id: reportId }, data: { gateStatus } }),
  ]);

  return { gateStatus, rigor, outcomes };
}
