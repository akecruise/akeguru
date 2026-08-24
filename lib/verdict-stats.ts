/**
 * Shared verdict-outcome helpers -- used by scripts/scorecard.ts and the home page's Scorecard
 * mini-panel, extracted here so both compute "did an invalidation trigger fire" and "is this WAIT
 * in regret" the same way instead of duplicating the logic in two places.
 */
import type { PrismaClient } from "../generated/prisma/client";
import type { TriggerComparator } from "./report/types";

export const REGRET_THRESHOLD_PCT = 15; // a WAIT that ran up 15%+ with no re-review is worth a second look

export function comparatorFires(comparator: TriggerComparator, value: number, threshold: number): boolean {
  switch (comparator) {
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
  }
}

/** Latest FinancialFact.value for this exact (ticker, metricName) -- "what's it reading right now,"
 *  not "does it exist" (checkInvalidationTriggers, run at report-generation time, already confirmed
 *  that). */
export async function latestFactValue(prisma: PrismaClient, ticker: string, metricName: string): Promise<number | null> {
  const row = await prisma.financialFact.findFirst({
    where: { ticker, metricName },
    orderBy: { extractedAt: "desc" },
    select: { value: true },
  });
  return row?.value ?? null;
}

export interface TriggerLike {
  metricName: string;
  comparator: TriggerComparator;
  threshold: number;
}

/** How many of `triggers` are currently fired against real, latest FinancialFact data. */
export async function countFiredTriggers(prisma: PrismaClient, ticker: string, triggers: TriggerLike[]): Promise<number> {
  let count = 0;
  for (const t of triggers) {
    const value = await latestFactValue(prisma, ticker, t.metricName);
    if (value !== null && comparatorFires(t.comparator, value, t.threshold)) count++;
  }
  return count;
}

/** Latest PriceHistory close on or before `date` — PriceHistory is only ever written for trading
 *  days the refresh job actually ran on, so an exact match on `date` isn't guaranteed (weekends, a
 *  missed refresh day). Nearest prior close is the honest "price at the time" either way. */
export async function priceOnOrBefore(prisma: PrismaClient, stockId: string, date: Date): Promise<number | null> {
  const row = await prisma.priceHistory.findFirst({
    where: { stockId, date: { lte: date } },
    orderBy: { date: "desc" },
    select: { close: true },
  });
  return row?.close ?? null;
}

export async function latestPrice(prisma: PrismaClient, stockId: string): Promise<number | null> {
  const row = await prisma.priceHistory.findFirst({ where: { stockId }, orderBy: { date: "desc" }, select: { close: true } });
  return row?.close ?? null;
}

/** A WAIT verdict whose price has since run up REGRET_THRESHOLD_PCT+ with nobody re-reviewing it --
 *  the specific failure mode a WAIT (a bet that there's no rush) needs to surface. Only meaningful
 *  for WAIT (a GO/NO_GO that ran up is a win/non-event, not a regret). */
export function isRegret(decision: string, returnPct: number | null): boolean {
  return decision === "WAIT" && returnPct !== null && returnPct >= REGRET_THRESHOLD_PCT;
}
