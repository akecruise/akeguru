import YahooFinance from "yahoo-finance2";

// Unofficial API — pin the exact version in package.json (see prior review) and
// keep concurrency conservative; Yahoo's crumb/cookie handshake 429s under load.
export const yahooFinance = new YahooFinance({
  queue: { concurrency: 2, interval: 250 },
});

export type MarketCode = "TH" | "US" | "HK";

export interface FetchedStock {
  name?: string;
  exchange?: string;
  currency?: string;
  sector?: string;
  industry?: string;
  description?: string;

  price?: number;
  priceChangePct1d?: number;
  marketCap?: number;
  /** 3-month average daily volume (shares/day) — combined with price for the liquidity check, see
   *  lib/refresh.ts's avgDailyValueUsd computation and lib/scoring.ts's modifier. */
  averageVolume?: number;
  sharesOutstanding?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  beta?: number;

  epsTtm?: number;
  bookValuePerShare?: number;
  revenueTtm?: number;
  totalCash?: number;

  peRatio?: number;
  forwardPe?: number;
  pbRatio?: number;
  psRatio?: number;
  evToEbitda?: number;

  estEarningsGrowth?: number;
  estRevenueGrowth?: number;

  analystTargetPrice?: number;
  recommendationMean?: number;
  numAnalystOpinions?: number;

  roe?: number;
  roa?: number;
  grossMargin?: number;
  operatingMargin?: number;
  netMargin?: number;

  debtToEquity?: number;
  currentRatio?: number;
  quickRatio?: number;

  dividendYield?: number;
  payoutRatio?: number;

  heldPercentInsiders?: number;
  heldPercentInstitutions?: number;
  floatShares?: number;

  /** true if the summaryDetail module was actually returned, even if dividendYield itself was absent from it. */
  hadSummaryDetail: boolean;
}

export async function fetchStockQuoteSummary(ticker: string): Promise<FetchedStock> {
  const r = await yahooFinance.quoteSummary(ticker, {
    modules: [
      "price",
      "summaryDetail",
      "defaultKeyStatistics",
      "financialData",
      "earningsTrend",
      "assetProfile",
    ],
  });

  const nextYearTrend = r.earningsTrend?.trend?.find((t) => t.period === "+1y");

  return {
    name: r.price?.longName ?? r.price?.shortName ?? undefined,
    exchange: r.price?.exchange ?? undefined,
    currency: r.price?.currency ?? undefined,
    sector: r.assetProfile?.sector ?? undefined,
    industry: r.assetProfile?.industry ?? undefined,
    description: r.assetProfile?.longBusinessSummary ?? undefined,

    price: r.price?.regularMarketPrice ?? undefined,
    priceChangePct1d: r.price?.regularMarketChangePercent ?? undefined,
    marketCap: r.price?.marketCap ?? r.summaryDetail?.marketCap ?? undefined,
    averageVolume: r.summaryDetail?.averageVolume ?? undefined,
    sharesOutstanding: r.defaultKeyStatistics?.sharesOutstanding ?? undefined,
    fiftyTwoWeekHigh: r.summaryDetail?.fiftyTwoWeekHigh ?? undefined,
    fiftyTwoWeekLow: r.summaryDetail?.fiftyTwoWeekLow ?? undefined,
    beta: r.summaryDetail?.beta ?? r.defaultKeyStatistics?.beta ?? undefined,

    epsTtm: r.defaultKeyStatistics?.trailingEps ?? undefined,
    bookValuePerShare: r.defaultKeyStatistics?.bookValue ?? undefined,
    revenueTtm: r.financialData?.totalRevenue ?? undefined,
    totalCash: r.financialData?.totalCash ?? undefined,

    peRatio: r.summaryDetail?.trailingPE ?? undefined,
    forwardPe: r.summaryDetail?.forwardPE ?? r.defaultKeyStatistics?.forwardPE ?? undefined,
    pbRatio: r.defaultKeyStatistics?.priceToBook ?? undefined,
    psRatio: r.summaryDetail?.priceToSalesTrailing12Months ?? undefined,
    evToEbitda: r.defaultKeyStatistics?.enterpriseToEbitda ?? undefined,

    estEarningsGrowth: nextYearTrend?.earningsEstimate?.growth ?? undefined,
    estRevenueGrowth: nextYearTrend?.revenueEstimate?.growth ?? undefined,

    analystTargetPrice: r.financialData?.targetMeanPrice ?? undefined,
    recommendationMean: r.financialData?.recommendationMean ?? undefined,
    numAnalystOpinions: r.financialData?.numberOfAnalystOpinions ?? undefined,

    roe: r.financialData?.returnOnEquity ?? undefined,
    roa: r.financialData?.returnOnAssets ?? undefined,
    grossMargin: r.financialData?.grossMargins ?? undefined,
    operatingMargin: r.financialData?.operatingMargins ?? undefined,
    netMargin: r.financialData?.profitMargins ?? undefined,

    debtToEquity: r.financialData?.debtToEquity ?? undefined,
    currentRatio: r.financialData?.currentRatio ?? undefined,
    quickRatio: r.financialData?.quickRatio ?? undefined,

    dividendYield: r.summaryDetail?.dividendYield ?? undefined,
    payoutRatio: r.summaryDetail?.payoutRatio ?? undefined,

    heldPercentInsiders: r.defaultKeyStatistics?.heldPercentInsiders ?? undefined,
    heldPercentInstitutions: r.defaultKeyStatistics?.heldPercentInstitutions ?? undefined,
    floatShares: r.defaultKeyStatistics?.floatShares ?? undefined,

    hadSummaryDetail: r.summaryDetail != null,
  };
}

export interface FetchedFinancialYear {
  period: string;
  fiscalDateEnding: Date;
  revenue: number | null;
  netIncome: number | null;
  eps: number | null;
  freeCashFlow: number | null;
  totalDebt: number | null;
  totalEquity: number | null;
}

/** Yahoo returns field names with the type ("annual"/"quarterly") stripped off already
 *  (e.g. both types yield `totalRevenue`, not `annualTotalRevenue`/`quarterlyTotalRevenue`)
 *  — verified against yahoo-finance2's own field-name-stripping logic, not assumed. */
export async function fetchFinancialHistory(
  ticker: string,
  type: "annual" | "quarterly" = "annual",
): Promise<FetchedFinancialYear[]> {
  // Since late 2024 the quoteSummary income/balance/cashflow-statement modules return
  // almost nothing — fundamentalsTimeSeries is the module that still has real data.
  const rows = await yahooFinance.fundamentalsTimeSeries(ticker, {
    period1: "2018-01-01",
    type,
    module: "all",
  });

  return rows
    .filter((row): row is typeof row & { date: Date } => row.date != null)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        period: type === "annual" ? String(row.date.getFullYear()) : quarterLabel(row.date),
        fiscalDateEnding: row.date,
        revenue: numOrNull(r.totalRevenue),
        netIncome: numOrNull(r.netIncome),
        eps: numOrNull(r.dilutedEPS) ?? numOrNull(r.basicEPS),
        freeCashFlow: numOrNull(r.freeCashFlow),
        totalDebt: numOrNull(r.totalDebt),
        totalEquity: numOrNull(r.stockholdersEquity),
      };
    })
    .filter((row) => row.revenue != null || row.netIncome != null);
}

function quarterLabel(date: Date): string {
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()}Q${quarter}`;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

const FX_SYMBOL: Partial<Record<MarketCode, string>> = {
  TH: "THB=X",
  HK: "HKD=X",
};

/** Local-currency-per-1-USD -> multiplier to convert a native-currency amount to USD (1 for US tickers, called by the refresh job). */
export async function fetchFxRateToUsd(market: MarketCode): Promise<number> {
  const symbol = FX_SYMBOL[market];
  if (!symbol) return 1;
  const q = await yahooFinance.quote(symbol);
  const rate = q?.regularMarketPrice;
  if (!rate) throw new Error(`Could not fetch ${symbol} FX rate`);
  return 1 / rate;
}

export interface FetchedPricePoint {
  date: Date;
  close: number;
}

/**
 * One-time-ish backfill for Momentum scoring: daily PriceHistory rows accumulate one point
 * per refresh, which would take months to produce a usable 12-month return. Weekly closes
 * over ~14 months give enough for 3/6/12-month returns immediately, at a small, bounded payload.
 */
export async function fetchWeeklyPriceHistory(ticker: string): Promise<FetchedPricePoint[]> {
  const period1 = new Date();
  period1.setDate(period1.getDate() - 430);

  const result = await yahooFinance.chart(ticker, {
    period1,
    interval: "1wk",
    return: "array",
  });

  return result.quotes
    .filter((q): q is typeof q & { date: Date; close: number } => q.date != null && q.close != null)
    .map((q) => ({ date: q.date, close: q.close }));
}
