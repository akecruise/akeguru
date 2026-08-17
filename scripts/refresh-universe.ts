import "dotenv/config";
import pg from "pg";
import pLimit from "p-limit";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../generated/prisma/client";
import { UNIVERSE_TH } from "../lib/data/universe-th";
import { UNIVERSE_US } from "../lib/data/universe-us";
import {
  fetchStockQuoteSummary,
  fetchFinancialHistory,
  fetchFxRateToUsd,
  fetchWeeklyPriceHistory,
  type MarketCode,
} from "../lib/yahoo";
import { scoreCohort, type ScorableStock } from "../lib/scoring";

// This script runs standalone (GitHub Actions / local CLI, via tsx) — it builds its own
// Prisma client against the DIRECT (unpooled) connection, mirroring lib/prisma.ts's adapter
// setup rather than sharing it, since a long batch job shouldn't compete with the app's
// pooled connection slots.
const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const CONCURRENCY = 5;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const CIRCUIT_BREAKER_MIN_PROCESSED = 20;
const CIRCUIT_BREAKER_FAILURE_RATIO = 0.2;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
      console.warn(`[refresh] ${label} failed (attempt ${attempt + 1}/${RETRY_ATTEMPTS}): ${(err as Error).message}. Retrying in ${delay}ms.`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function todayUtcMidnight(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

interface Failure {
  ticker: string;
  message: string;
}

async function refreshTicker(
  ticker: string,
  market: MarketCode,
  fxRateToUsd: number,
): Promise<void> {
  const fetched = await withRetry(() => fetchStockQuoteSummary(ticker), `quoteSummary(${ticker})`);

  const currency = fetched.currency ?? (market === "TH" ? "THB" : "USD");
  const marketCapUsd = fetched.marketCap != null ? fetched.marketCap * fxRateToUsd : undefined;
  // Confirmed non-payer (summaryDetail returned but no yield) -> write 0, not null, so scoring
  // never needs a dividend-specific "missing vs. zero" branch. A whole-ticker fetch failure
  // (caught below, never reaches here) is the only case that leaves dividendYield untouched.
  const dividendYield = fetched.dividendYield ?? (fetched.hadSummaryDetail ? 0 : undefined);

  // Only include fields that actually came back — never let a transient per-field miss on an
  // otherwise-successful fetch clobber yesterday's good value with null.
  const updateData = {
    ...(fetched.name != null && { name: fetched.name }),
    ...(fetched.exchange != null && { exchange: fetched.exchange }),
    ...(currency != null && { currency }),
    ...(fetched.sector != null && { sector: fetched.sector }),
    ...(fetched.industry != null && { industry: fetched.industry }),
    ...(fetched.description != null && { description: fetched.description }),
    ...(fetched.price != null && { price: fetched.price }),
    ...(fetched.priceChangePct1d != null && { priceChangePct1d: fetched.priceChangePct1d }),
    ...(fetched.marketCap != null && { marketCap: fetched.marketCap }),
    ...(marketCapUsd != null && { marketCapUsd }),
    ...(fxRateToUsd != null && { fxRateToUsd }),
    ...(fetched.sharesOutstanding != null && { sharesOutstanding: fetched.sharesOutstanding }),
    ...(fetched.fiftyTwoWeekHigh != null && { fiftyTwoWeekHigh: fetched.fiftyTwoWeekHigh }),
    ...(fetched.fiftyTwoWeekLow != null && { fiftyTwoWeekLow: fetched.fiftyTwoWeekLow }),
    ...(fetched.beta != null && { beta: fetched.beta }),
    ...(fetched.epsTtm != null && { epsTtm: fetched.epsTtm }),
    ...(fetched.bookValuePerShare != null && { bookValuePerShare: fetched.bookValuePerShare }),
    ...(fetched.revenueTtm != null && { revenueTtm: fetched.revenueTtm }),
    ...(fetched.totalCash != null && { totalCash: fetched.totalCash }),
    ...(fetched.peRatio != null && { peRatio: fetched.peRatio }),
    ...(fetched.forwardPe != null && { forwardPe: fetched.forwardPe }),
    ...(fetched.pbRatio != null && { pbRatio: fetched.pbRatio }),
    ...(fetched.psRatio != null && { psRatio: fetched.psRatio }),
    ...(fetched.evToEbitda != null && { evToEbitda: fetched.evToEbitda }),
    ...(fetched.estEarningsGrowth != null && { estEarningsGrowth: fetched.estEarningsGrowth }),
    ...(fetched.estRevenueGrowth != null && { estRevenueGrowth: fetched.estRevenueGrowth }),
    ...(fetched.analystTargetPrice != null && { analystTargetPrice: fetched.analystTargetPrice }),
    ...(fetched.recommendationMean != null && { recommendationMean: fetched.recommendationMean }),
    ...(fetched.numAnalystOpinions != null && { numAnalystOpinions: fetched.numAnalystOpinions }),
    ...(fetched.roe != null && { roe: fetched.roe }),
    ...(fetched.roa != null && { roa: fetched.roa }),
    ...(fetched.grossMargin != null && { grossMargin: fetched.grossMargin }),
    ...(fetched.operatingMargin != null && { operatingMargin: fetched.operatingMargin }),
    ...(fetched.netMargin != null && { netMargin: fetched.netMargin }),
    ...(fetched.debtToEquity != null && { debtToEquity: fetched.debtToEquity }),
    ...(fetched.currentRatio != null && { currentRatio: fetched.currentRatio }),
    ...(fetched.quickRatio != null && { quickRatio: fetched.quickRatio }),
    ...(dividendYield != null && { dividendYield }),
    ...(fetched.payoutRatio != null && { payoutRatio: fetched.payoutRatio }),
    ...(fetched.heldPercentInsiders != null && { heldPercentInsiders: fetched.heldPercentInsiders }),
    ...(fetched.heldPercentInstitutions != null && {
      heldPercentInstitutions: fetched.heldPercentInstitutions,
    }),
    ...(fetched.floatShares != null && { floatShares: fetched.floatShares }),
    isActive: true,
    lastFetchedAt: new Date(),
  };

  const stock = await prisma.stock.upsert({
    where: { ticker },
    create: {
      ticker,
      market,
      exchange: fetched.exchange ?? (market === "TH" ? "SET" : "UNKNOWN"),
      name: fetched.name ?? ticker,
      currency,
      ...updateData,
    },
    update: updateData,
  });

  if (fetched.price != null) {
    await prisma.priceHistory.upsert({
      where: { stockId_date: { stockId: stock.id, date: todayUtcMidnight() } },
      create: { stockId: stock.id, date: todayUtcMidnight(), close: fetched.price },
      update: { close: fetched.price },
    });
  }

  // Daily closes alone would take ~14 months to produce a usable 12-month return. Backfill
  // once (guarded by a row-count check, not a "have we ever run this" flag) so Momentum
  // scoring works from day one instead of silently returning null for months.
  const existingPriceRows = await prisma.priceHistory.count({ where: { stockId: stock.id } });
  if (existingPriceRows < 8) {
    try {
      const history = await withRetry(() => fetchWeeklyPriceHistory(ticker), `chart(${ticker})`);
      for (const point of history) {
        const date = new Date(Date.UTC(point.date.getUTCFullYear(), point.date.getUTCMonth(), point.date.getUTCDate()));
        await prisma.priceHistory.upsert({
          where: { stockId_date: { stockId: stock.id, date } },
          create: { stockId: stock.id, date, close: point.close },
          update: { close: point.close },
        });
      }
    } catch (err) {
      console.warn(`[refresh] price history backfill failed for ${ticker}: ${(err as Error).message}`);
    }
  }

  if (fetched.price != null) {
    const years = await withRetry(() => fetchFinancialHistory(ticker), `fundamentalsTimeSeries(${ticker})`);
    for (const year of years) {
      await prisma.financialHistory.upsert({
        where: { stockId_period_periodType: { stockId: stock.id, period: year.period, periodType: "ANNUAL" } },
        create: {
          stockId: stock.id,
          period: year.period,
          periodType: "ANNUAL",
          fiscalDateEnding: year.fiscalDateEnding,
          revenue: year.revenue,
          netIncome: year.netIncome,
          eps: year.eps,
          freeCashFlow: year.freeCashFlow,
          totalDebt: year.totalDebt,
          totalEquity: year.totalEquity,
        },
        update: {
          fiscalDateEnding: year.fiscalDateEnding,
          ...(year.revenue != null && { revenue: year.revenue }),
          ...(year.netIncome != null && { netIncome: year.netIncome }),
          ...(year.eps != null && { eps: year.eps }),
          ...(year.freeCashFlow != null && { freeCashFlow: year.freeCashFlow }),
          ...(year.totalDebt != null && { totalDebt: year.totalDebt }),
          ...(year.totalEquity != null && { totalEquity: year.totalEquity }),
        },
      });
    }
  }
}

function todayForScore(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Scores one market cohort and persists ScoreSnapshot + the denormalized Stock.latest* fields. Errors are logged, not thrown — a scoring bug shouldn't mark an otherwise-successful data refresh as failed. */
async function scoreMarket(market: MarketCode): Promise<void> {
  const stocks = await prisma.stock.findMany({
    where: { market, isActive: true },
    include: { financialHistory: true, priceHistory: true },
  });

  const scorable: ScorableStock[] = stocks.map((s) => ({
    id: s.id,
    peRatio: s.peRatio,
    pbRatio: s.pbRatio,
    evToEbitda: s.evToEbitda,
    psRatio: s.psRatio,
    estEarningsGrowth: s.estEarningsGrowth,
    estRevenueGrowth: s.estRevenueGrowth,
    debtToEquity: s.debtToEquity,
    currentRatio: s.currentRatio,
    interestCoverage: s.interestCoverage,
    dividendYield: s.dividendYield,
    payoutRatio: s.payoutRatio,
    financialHistory: s.financialHistory,
    priceHistory: s.priceHistory,
  }));

  const results = scoreCohort(scorable);
  const date = todayForScore();

  for (const [stockId, result] of results) {
    await prisma.scoreSnapshot.upsert({
      where: { stockId_date: { stockId, date } },
      create: {
        stockId,
        date,
        valueScore: result.valueScore,
        futureScore: result.futureScore,
        pastScore: result.pastScore,
        healthScore: result.healthScore,
        dividendScore: result.dividendScore,
        momentumScore: result.momentumScore,
        overallScore: result.overallScore,
        rawMetricsJson: result.rawMetrics as unknown as Prisma.InputJsonValue,
      },
      update: {
        valueScore: result.valueScore,
        futureScore: result.futureScore,
        pastScore: result.pastScore,
        healthScore: result.healthScore,
        dividendScore: result.dividendScore,
        momentumScore: result.momentumScore,
        overallScore: result.overallScore,
        rawMetricsJson: result.rawMetrics as unknown as Prisma.InputJsonValue,
      },
    });

    await prisma.stock.update({
      where: { id: stockId },
      data: {
        latestOverallScore: result.overallScore,
        latestValueScore: result.valueScore,
        latestFutureScore: result.futureScore,
        latestPastScore: result.pastScore,
        latestHealthScore: result.healthScore,
        latestDividendScore: result.dividendScore,
        latestMomentumScore: result.momentumScore,
        latestScoreDate: date,
      },
    });
  }

  console.log(`[refresh] scored ${results.size} ${market} stocks`);
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const log = await prisma.refreshLog.create({
    data: { startedAt, status: "FAILED" }, // overwritten below; defaults to FAILED in case of a crash before we update it
  });

  const tickers: Array<{ ticker: string; market: MarketCode }> = [
    ...UNIVERSE_TH.map((ticker) => ({ ticker, market: "TH" as const })),
    ...UNIVERSE_US.map((ticker) => ({ ticker, market: "US" as const })),
  ];

  const fxRates: Record<MarketCode, number> = {
    TH: await fetchFxRateToUsd("TH"),
    US: 1,
  };

  const limit = pLimit(CONCURRENCY);
  const failures: Failure[] = [];
  let processed = 0;
  let breakerTripped = false;

  await Promise.all(
    tickers.map(({ ticker, market }) =>
      limit(async () => {
        if (breakerTripped) return;
        try {
          await refreshTicker(ticker, market, fxRates[market]);
        } catch (err) {
          failures.push({ ticker, message: (err as Error).message });
        } finally {
          processed++;
          if (
            processed >= CIRCUIT_BREAKER_MIN_PROCESSED &&
            failures.length / processed > CIRCUIT_BREAKER_FAILURE_RATIO
          ) {
            breakerTripped = true;
          }
        }
      }),
    ),
  );

  try {
    await scoreMarket("TH");
    await scoreMarket("US");
  } catch (err) {
    console.error("[refresh] scoring pass failed:", err);
  }

  const status = breakerTripped
    ? "FAILED"
    : failures.length > 0
      ? "PARTIAL"
      : "SUCCESS";

  await prisma.refreshLog.update({
    where: { id: log.id },
    data: {
      finishedAt: new Date(),
      status,
      tickersProcessed: processed,
      tickersFailed: failures.length,
      errorSummary:
        failures.length > 0
          ? (breakerTripped ? "Circuit breaker tripped. " : "") +
            failures.slice(0, 20).map((f) => `${f.ticker}: ${f.message}`).join("; ")
          : null,
    },
  });

  console.log(`[refresh] done: ${status}, processed=${processed}, failed=${failures.length}${breakerTripped ? " (circuit breaker tripped)" : ""}`);

  await prisma.$disconnect();
  await pool.end();

  if (status === "FAILED") process.exitCode = 1;
}

main().catch(async (err) => {
  console.error("[refresh] fatal error:", err);
  await prisma.$disconnect();
  await pool.end();
  process.exitCode = 1;
});
