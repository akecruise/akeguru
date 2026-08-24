import { prisma } from "@/lib/prisma";
import { computeConsensus, DEFAULT_TRUST_WEIGHTS } from "@/lib/consensus";
import { GURU_LENSES, buildPoolContext, analystUpsidePct, type GuruCandidate, type LensVerdict } from "@/lib/guru-lens";
import { computeTurtleSignal, computeATR, suggestTurtleWeight, ATR_WEEKS, type WeeklyBar } from "@/lib/turtle";
import { readAnalyzeStatus } from "@/lib/analyze-status";
import type { Market } from "../../generated/prisma/client";
import type { StockReport, MoatItem } from "@/lib/report/types";
import { GuruLensApp, type DisplayCandidate } from "@/components/GuruLensApp";

const MARKETS: Market[] = ["TH", "US", "HK"];
const MOAT_STRENGTH_SCORE: Record<MoatItem["strength"], number> = { strong: 100, moderate: 65, weak: 35 };

function moatScoreOf(moat: MoatItem[] | undefined): number | null {
  if (!moat) return null;
  const real = moat.filter((m) => m.type !== "none");
  if (real.length === 0) return 0; // analyzed, no real moat found -- a real (low) score, not "unknown"
  return real.reduce((sum, m) => sum + MOAT_STRENGTH_SCORE[m.strength], 0) / real.length;
}

export default async function GuruLensPage() {
  const stocks = await prisma.stock.findMany({
    where: { isActive: true, latestOverallScore: { not: null } },
    select: {
      id: true, ticker: true, name: true, sector: true, market: true, price: true, currency: true, priceChangePct1d: true,
      analystTargetPrice: true, numAnalystOpinions: true, peRatio: true, pegRatio: true, roe: true, roa: true, evToEbitda: true,
      estEarningsGrowth: true, dividendYield: true, lynchCategory: true,
      latestValueScore: true, latestFutureScore: true, latestHealthScore: true, latestMomentumScore: true, latestOverallScore: true,
    },
  });

  const [reports, regimes, priceRows] = await Promise.all([
    prisma.researchReport.findMany({
      where: { ticker: { in: stocks.map((s) => s.ticker) } },
      orderBy: [{ ticker: "asc" }, { dataAsOf: "desc" }, { createdAt: "desc" }],
      select: { id: true, ticker: true, decision: true, conviction: true, payload: true },
    }),
    Promise.all(MARKETS.map((m) => prisma.marketRegime.findFirst({ where: { market: m }, orderBy: { date: "desc" }, select: { market: true, classification: true } }))),
    // Batched -- one query for every candidate's price history, not one query per stock (see
    // app/page.tsx's gate-log comment for why that matters against local prisma dev).
    prisma.priceHistory.findMany({
      where: { stockId: { in: stocks.map((s) => s.id) }, high: { not: null }, low: { not: null } },
      orderBy: { date: "asc" },
      select: { stockId: true, date: true, high: true, low: true, close: true },
    }),
  ]);

  const reportByTicker = new Map<string, (typeof reports)[number]>();
  for (const r of reports) if (!reportByTicker.has(r.ticker)) reportByTicker.set(r.ticker, r);

  const gateLogs = await prisma.qualityGateLog.findMany({
    where: { reportId: { in: [...reportByTicker.values()].map((r) => r.id) } },
    select: { reportId: true, passed: true },
  });
  const gateCountByReport = new Map<string, { passed: number; total: number }>();
  for (const log of gateLogs) {
    const cur = gateCountByReport.get(log.reportId) ?? { passed: 0, total: 0 };
    cur.total++;
    if (log.passed) cur.passed++;
    gateCountByReport.set(log.reportId, cur);
  }

  const regimeByMarket = new Map(regimes.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => [r.market, r.classification as "RISK_ON" | "RISK_OFF" | "MIXED"]));

  const barsByStock = new Map<string, WeeklyBar[]>();
  for (const p of priceRows) {
    const arr = barsByStock.get(p.stockId) ?? [];
    arr.push({ high: p.high!, low: p.low!, close: p.close });
    barsByStock.set(p.stockId, arr);
  }

  const pool: GuruCandidate[] = stocks.map((s) => {
    const report = reportByTicker.get(s.ticker);
    const payload = report?.payload as unknown as StockReport | undefined;
    const gates = report ? gateCountByReport.get(report.id) : undefined;
    const bars = barsByStock.get(s.id) ?? [];
    const signal = computeTurtleSignal(bars);
    const n = computeATR(bars, ATR_WEEKS);
    const sized = s.price != null ? suggestTurtleWeight(s.price, n) : null;
    return {
      id: s.id,
      ticker: s.ticker,
      price: s.price,
      analystTargetPrice: s.analystTargetPrice,
      numAnalystOpinions: s.numAnalystOpinions,
      peRatio: s.peRatio,
      pegRatio: s.pegRatio,
      roe: s.roe,
      roa: s.roa,
      evToEbitda: s.evToEbitda,
      estEarningsGrowth: s.estEarningsGrowth,
      dividendYield: s.dividendYield,
      lynchCategory: s.lynchCategory,
      latestValueScore: s.latestValueScore,
      latestFutureScore: s.latestFutureScore,
      latestHealthScore: s.latestHealthScore,
      latestMomentumScore: s.latestMomentumScore,
      latestOverallScore: s.latestOverallScore,
      regime: regimeByMarket.get(s.market) ?? null,
      hasReport: !!report,
      moatScore: moatScoreOf(payload?.moat),
      gatesPassed: gates?.passed ?? null,
      gatesTotal: gates?.total ?? null,
      turtleConfirmed: signal.confirmedLong ? "long" : signal.confirmedShort ? "short" : "none",
      turtleWeightPct: sized?.suggestedWeightPct ?? null,
    };
  });

  const ctx = buildPoolContext(pool);
  const consensus = computeConsensus(
    pool.map((c) => ({
      id: c.id,
      latestOverallScore: c.latestOverallScore,
      latestMomentumScore: c.latestMomentumScore,
      roa: c.roa,
      evToEbitda: c.evToEbitda,
      estEarningsGrowth: c.estEarningsGrowth,
      dividendYield: c.dividendYield,
      peRatio: c.peRatio,
      pegRatio: c.pegRatio,
      turtleConfirmed: c.turtleConfirmed,
    })),
    DEFAULT_TRUST_WEIGHTS,
  );
  const consensusById = new Map(consensus.map((c) => [c.id, c.consensusScore]));

  const stockById = new Map(stocks.map((s) => [s.id, s]));
  const display: DisplayCandidate[] = pool.map((c) => {
    const s = stockById.get(c.id)!;
    const report = reportByTicker.get(c.ticker);
    const n = (() => {
      const bars = barsByStock.get(c.id) ?? [];
      return computeATR(bars, ATR_WEEKS);
    })();
    const bars = barsByStock.get(c.id) ?? [];
    const signal = computeTurtleSignal(bars);
    const lensResults = Object.fromEntries(GURU_LENSES.map((L) => [L.id, L.eval(c, ctx)])) as Record<string, { verdict: LensVerdict; reason: string }>;
    return {
      id: c.id,
      ticker: c.ticker,
      name: s.name,
      sector: s.sector,
      price: s.price,
      currency: s.currency,
      priceChangePct1d: s.priceChangePct1d,
      consensusScore: consensusById.get(c.id) ?? null,
      mosProxy: analystUpsidePct(c),
      decision: (report?.decision as "GO" | "WAIT" | "NO_GO" | undefined) ?? null,
      conviction: report?.conviction ?? null,
      hasReport: !!report,
      turtleConfirmed: c.turtleConfirmed,
      turtleWeightPct: c.turtleWeightPct,
      turtleN: n,
      turtleExitLow: signal.system2?.exitLow ?? signal.system1?.exitLow ?? null,
      lensResults,
      bars: bars.map((b) => ({ high: b.high, low: b.low, close: b.close })),
      analyzeStatus: readAnalyzeStatus(c.ticker),
    };
  });

  return <GuruLensApp candidates={display} lensMeta={GURU_LENSES.map(({ id, name, tag, quote, rule }) => ({ id, name, tag, quote, rule }))} />;
}
