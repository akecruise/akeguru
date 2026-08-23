import fs from "fs/promises";
import path from "path";
import pLimit from "p-limit";
import type { PrismaClient, Prisma } from "../generated/prisma/client";
import { UNIVERSE_TH } from "./data/universe-th";
import { UNIVERSE_US } from "./data/universe-us";
import { UNIVERSE_HK } from "./data/universe-hk";
import {
  fetchStockQuoteSummary,
  fetchFinancialHistory,
  fetchFxRateToUsd,
  fetchWeeklyPriceHistory,
  type MarketCode,
} from "./yahoo";
import { scoreCohort, type ScorableStock } from "./scoring";
import { classifyLynchCategory, computePegRatio } from "./lynch";
import { report } from "./progress";

// Shared by scripts/refresh-universe.ts (CLI/local, own direct-connection Prisma client) and
// app/api/cron/refresh/route.ts (Vercel Cron, own direct-connection Prisma client) — both build
// their own PrismaClient against the unpooled connection and pass it in here, rather than this
// module owning connection setup itself.

const CONCURRENCY = 5;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const CIRCUIT_BREAKER_MIN_PROCESSED = 20;
const CIRCUIT_BREAKER_FAILURE_RATIO = 0.2;

const DEFAULT_CURRENCY: Record<MarketCode, string> = { TH: "THB", US: "USD", HK: "HKD" };
const DEFAULT_EXCHANGE: Record<MarketCode, string> = { TH: "SET", US: "UNKNOWN", HK: "HKEX" };

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
  prisma: PrismaClient,
  ticker: string,
  market: MarketCode,
  fxRateToUsd: number,
): Promise<void> {
  const fetched = await withRetry(() => fetchStockQuoteSummary(ticker), `quoteSummary(${ticker})`);

  const currency = fetched.currency ?? DEFAULT_CURRENCY[market];
  const marketCapUsd = fetched.marketCap != null ? fetched.marketCap * fxRateToUsd : undefined;
  // Liquidity check (Phase 1): 3-month avg daily volume x price, converted to USD the same way
  // marketCapUsd is above, for a cross-market-comparable "can I actually trade this size" figure.
  // See lib/scoring.ts for the tiers/modifier this feeds into.
  const avgDailyValueUsd =
    fetched.averageVolume != null && fetched.price != null ? fetched.averageVolume * fetched.price * fxRateToUsd : undefined;
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
    ...(avgDailyValueUsd != null && { avgDailyValueUsd }),
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
      exchange: fetched.exchange ?? DEFAULT_EXCHANGE[market],
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
    const years = await withRetry(() => fetchFinancialHistory(ticker, "annual"), `fundamentalsTimeSeries(${ticker}, annual)`);
    await upsertFinancialHistory(prisma, stock.id, "ANNUAL", years);

    try {
      const quarters = await withRetry(
        () => fetchFinancialHistory(ticker, "quarterly"),
        `fundamentalsTimeSeries(${ticker}, quarterly)`,
      );
      await upsertFinancialHistory(prisma, stock.id, "QUARTERLY", quarters);
    } catch (err) {
      // Quarterly data is a nice-to-have on top of annual — don't fail the whole ticker refresh
      // over it (some tickers, especially thinly-covered TH ones, simply lack quarterly detail).
      console.warn(`[refresh] quarterly financials failed for ${ticker}: ${(err as Error).message}`);
    }
  }
}

async function upsertFinancialHistory(
  prisma: PrismaClient,
  stockId: string,
  periodType: "ANNUAL" | "QUARTERLY",
  periods: Awaited<ReturnType<typeof fetchFinancialHistory>>,
): Promise<void> {
  for (const period of periods) {
    await prisma.financialHistory.upsert({
      where: { stockId_period_periodType: { stockId, period: period.period, periodType } },
      create: {
        stockId,
        period: period.period,
        periodType,
        fiscalDateEnding: period.fiscalDateEnding,
        revenue: period.revenue,
        netIncome: period.netIncome,
        eps: period.eps,
        freeCashFlow: period.freeCashFlow,
        totalDebt: period.totalDebt,
        totalEquity: period.totalEquity,
      },
      update: {
        fiscalDateEnding: period.fiscalDateEnding,
        ...(period.revenue != null && { revenue: period.revenue }),
        ...(period.netIncome != null && { netIncome: period.netIncome }),
        ...(period.eps != null && { eps: period.eps }),
        ...(period.freeCashFlow != null && { freeCashFlow: period.freeCashFlow }),
        ...(period.totalDebt != null && { totalDebt: period.totalDebt }),
        ...(period.totalEquity != null && { totalEquity: period.totalEquity }),
      },
    });
  }
}

function todayForScore(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Scores one market cohort and persists ScoreSnapshot + the denormalized Stock.latest* fields. Errors are logged, not thrown — a scoring bug shouldn't mark an otherwise-successful data refresh as failed. */
async function scoreMarket(prisma: PrismaClient, market: MarketCode): Promise<void> {
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
    avgDailyValueUsd: s.avgDailyValueUsd,
    financialHistory: s.financialHistory,
    priceHistory: s.priceHistory,
  }));

  const results = scoreCohort(scorable);
  const date = todayForScore();
  const stockById = new Map(stocks.map((s) => [s.id, s]));

  for (const [stockId, result] of results) {
    const stock = stockById.get(stockId)!;
    const lynchCategory = classifyLynchCategory({ estEarningsGrowth: stock.estEarningsGrowth, sector: stock.sector, beta: stock.beta });
    const pegRatio = computePegRatio(stock.peRatio, stock.estEarningsGrowth);

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
        liquidityTier: result.liquidityTier,
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
        liquidityTier: result.liquidityTier,
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
        latestLiquidityTier: result.liquidityTier,
        lynchCategory,
        pegRatio,
        latestScoreDate: date,
      },
    });
  }

  console.log(`[refresh] scored ${results.size} ${market} stocks`);
}

/**
 * Appends a one-run summary to the vault's Pipeline Dashboard.md -- same "skip if unset, never
 * fail the run over it" convention as lib/report/obsidian-export.ts (a Vercel-hosted instance has
 * no filesystem access to a local vault either, same reasoning that file documents). Append-only
 * (not a rewrite) so history accumulates across runs instead of only ever showing the latest one.
 */
async function appendToObsidianDashboard(
  runId: string,
  result: RefreshResult,
  startedAt: Date,
  finishedAt: Date,
  failures: Failure[],
): Promise<void> {
  const vaultRoot = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRoot) return;

  const durationMin = ((finishedAt.getTime() - startedAt.getTime()) / 60_000).toFixed(1);
  const statusIcon = result.status === "SUCCESS" ? "✅" : result.status === "PARTIAL" ? "⚠️" : "❌";
  const failureLines = failures.length
    ? failures.slice(0, 10).map((f) => `  - ${f.ticker}: ${f.message}`).join("\n")
    : "  - none";

  const block = [
    `## Refresh ${runId}`,
    `- Status: ${statusIcon} ${result.status} | ${result.processed} processed, ${result.failed} failed | ${durationMin}m`,
    `- Failures:${failures.length ? "\n" + failureLines : " none"}`,
    "",
  ].join("\n");

  const filePath = path.join(vaultRoot, "Pipeline Dashboard.md");
  await fs.appendFile(filePath, `\n${block}`, "utf-8");
}

export interface RefreshResult {
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  processed: number;
  failed: number;
}

export async function runRefresh(prisma: PrismaClient): Promise<RefreshResult> {
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const log = await prisma.refreshLog.create({
    data: { startedAt, status: "FAILED" }, // overwritten below; defaults to FAILED in case of a crash before we update it
  });

  const tickers: Array<{ ticker: string; market: MarketCode }> = [
    ...UNIVERSE_TH.map((ticker) => ({ ticker, market: "TH" as const })),
    ...UNIVERSE_US.map((ticker) => ({ ticker, market: "US" as const })),
    ...UNIVERSE_HK.map((ticker) => ({ ticker, market: "HK" as const })),
  ];

  report({
    runId,
    startedAt: startedAt.toISOString(),
    currentStage: "fetch",
    stage: 1,
    totalStages: 3,
    tickersDone: 0,
    tickersTotal: tickers.length,
    status: "running",
    lastError: null,
  });

  // Anything below can throw before reaching the refreshLog.update()/report() calls that record a
  // final status either way -- without this, a crash here (e.g. fetchFxRateToUsd failing) would
  // leave logs/status.json parked at "running" forever, which a watcher (scripts/watch-status.ps1)
  // has no way to tell apart from a run that's still actually in progress.
  try {
    const fxRates: Record<MarketCode, number> = {
      TH: await fetchFxRateToUsd("TH"),
      US: 1,
      HK: await fetchFxRateToUsd("HK"),
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
            await refreshTicker(prisma, ticker, market, fxRates[market]);
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
            // Passed straight from in-memory counters (not "read the file, add one"), so this
            // stays correct even with CONCURRENCY calls landing their writes out of order.
            report({ tickersDone: processed, lastError: failures.at(-1)?.message ?? null });
          }
        }),
      ),
    );

    report({ currentStage: "scoring", stage: 2 });
    try {
      await scoreMarket(prisma, "TH");
      await scoreMarket(prisma, "US");
      await scoreMarket(prisma, "HK");
    } catch (err) {
      console.error("[refresh] scoring pass failed:", err);
    }

    const status: RefreshResult["status"] = breakerTripped
      ? "FAILED"
      : failures.length > 0
        ? "PARTIAL"
        : "SUCCESS";
    const finishedAt = new Date();

    await prisma.refreshLog.update({
      where: { id: log.id },
      data: {
        finishedAt,
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

    const result: RefreshResult = { status, processed, failed: failures.length };

    report({
      currentStage: "done",
      stage: 3,
      status: status === "FAILED" ? "failed" : "done",
      tickersDone: processed,
      lastError: failures.length > 0 ? `${failures.length} ticker(s) failed` : null,
    });

    try {
      await appendToObsidianDashboard(runId, result, startedAt, finishedAt, failures);
    } catch (err) {
      console.error("[refresh] Obsidian dashboard append failed (non-fatal):", err);
    }

    console.log(`[refresh] done: ${status}, processed=${processed}, failed=${failures.length}${breakerTripped ? " (circuit breaker tripped)" : ""}`);

    return result;
  } catch (err) {
    report({ currentStage: "crashed", status: "failed", lastError: (err as Error).message });
    throw err;
  }
}
