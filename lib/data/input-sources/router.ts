/**
 * Input Layer Router — เลือกแหล่งข้อมูลตามตลาด
 *
 *   US  -> SEC EDGAR (XBRL structured) + Yahoo
 *   HK  -> Yahoo + HKEX PDF (ต้นฉบับให้ Gate 6)
 *   TH  -> Yahoo (.BK) + ก.ล.ต. API + SET factsheet
 *
 * หลักการเดียวกันทุกตลาด:
 *   Yahoo เป็นฐาน ratios (structured, ฟรี, map ด้วยโค้ด = 0 token)
 *   แหล่งทางการเป็นต้นฉบับให้ traceability + Gate 6
 */

import { archiveSec } from './sec';
import { searchFilings, archiveHkexFiling, checkCoverage, isAnnualReportTitle } from './hkex';
import { archiveThai, normalizeThai, isThai } from './th';
import { yahooFinance } from '../../yahoo'; // shared, rate-limited client (see lib/yahoo.ts) — a second unconfigured client here would defeat its 429 protection
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export type Exchange = 'SEC' | 'HKEX' | 'SET';

export function detectExchange(ticker: string): Exchange {
  if (/\.HK$/i.test(ticker) || /^SEHK/i.test(ticker)) return 'HKEX';
  if (isThai(ticker)) return 'SET';
  return 'SEC';
}

/** ticker ที่ Yahoo เข้าใจ */
export function toYahooTicker(ticker: string, ex: Exchange): string {
  if (ex === 'SET') return normalizeThai(ticker).yahoo;      // PTT -> PTT.BK
  if (ex === 'HKEX') return ticker.toUpperCase();            // 1773.HK
  return ticker.replace(/\..*$/, '').toUpperCase();          // MSFT
}

// ---------- Yahoo (ใช้ได้ทุกตลาด) ----------

const YAHOO_MODULES = [
  'price',
  'summaryDetail',
  'financialData',
  'defaultKeyStatistics',
  'earningsTrend',
  'incomeStatementHistory',
  'balanceSheetHistory',
  'cashflowStatementHistory',
] as const;

export async function archiveYahoo(yTicker: string, rootDir = 'raw-sources') {
  const raw = await yahooFinance.quoteSummary(yTicker, { modules: [...YAHOO_MODULES] as any });
  const body = JSON.stringify(raw, null, 2);
  const hash = crypto.createHash('sha256').update(body).digest('hex');

  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(rootDir, 'YAHOO', yTicker, day);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'quotesummary.json');
  await fs.writeFile(filePath, body);

  return {
    rawSource: {
      ticker: yTicker,
      market: 'YAHOO' as const,
      filePath,
      sha256Hash: hash,
      fetchedBy: 'router.ts:archiveYahoo',
      fetchedAt: new Date(),
    },
    data: raw,
  };
}

/** map Yahoo -> FinancialFact (โค้ดล้วน ไม่ใช้ AI) */
export const YAHOO_FIELD_MAP: Record<
  string,
  { metricName: string; unit: string; pct?: boolean; divideBy100?: boolean }
> = {
  'summaryDetail.trailingPE':                 { metricName: 'P/E',           unit: 'x' },
  'defaultKeyStatistics.priceToBook':         { metricName: 'P/B',           unit: 'x' },
  'defaultKeyStatistics.enterpriseToEbitda':  { metricName: 'EV/EBITDA',     unit: 'x' },
  'defaultKeyStatistics.enterpriseToRevenue': { metricName: 'EV/Sales',      unit: 'x' },
  'financialData.returnOnEquity':             { metricName: 'ROE',           unit: '%', pct: true },
  'financialData.returnOnAssets':             { metricName: 'ROA',           unit: '%', pct: true },
  // Unlike the ratio fields above (returned as a 0-1 fraction, need *100 to become a %),
  // Yahoo already returns debtToEquity pre-scaled as if it were a percentage (e.g. 85.7 for a
  // true 0.857 ratio) — confirmed against 1773.HK during Phase -1 coverage testing (Fiscal.ai: 0.9,
  // raw Yahoo: 85.7). Divide by 100 to get back to an actual x ratio.
  'financialData.debtToEquity':               { metricName: 'Debt/Equity',   unit: 'x', divideBy100: true },
  'financialData.currentRatio':               { metricName: 'Current Ratio', unit: 'x' },
  'financialData.grossMargins':               { metricName: 'Gross Margin',  unit: '%', pct: true },
  'financialData.ebitdaMargins':              { metricName: 'EBITDA Margin', unit: '%', pct: true },
  'financialData.operatingMargins':           { metricName: 'Operating Margin', unit: '%', pct: true },
  'financialData.profitMargins':              { metricName: 'Net Margin',    unit: '%', pct: true },
  'financialData.revenueGrowth':              { metricName: 'Revenue Growth',unit: '%', pct: true },
  'financialData.earningsGrowth':             { metricName: 'Earnings Growth', unit: '%', pct: true },
  'financialData.totalRevenue':               { metricName: 'Revenue',       unit: 'currency' },
  'financialData.totalCash':                  { metricName: 'Cash',          unit: 'currency' },
  'financialData.totalDebt':                  { metricName: 'Total Debt',    unit: 'currency' },
  'financialData.freeCashflow':               { metricName: 'FCF',           unit: 'currency' },
  'financialData.operatingCashflow':          { metricName: 'CFO',           unit: 'currency' },
  'price.marketCap':                          { metricName: 'Market Cap',    unit: 'currency' },
  'defaultKeyStatistics.enterpriseValue':     { metricName: 'EV',            unit: 'currency' },
  'defaultKeyStatistics.sharesOutstanding':   { metricName: 'Shares Out',    unit: 'count' },
  'summaryDetail.dividendYield':              { metricName: 'Dividend Yield',unit: '%', pct: true },
  'summaryDetail.payoutRatio':                { metricName: 'Payout Ratio',  unit: '%', pct: true },
};

function dig(obj: any, dotted: string) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function mapYahooFacts(data: any, rawSourceId: string, ticker: string) {
  const facts: any[] = [];
  for (const [pathKey, def] of Object.entries(YAHOO_FIELD_MAP)) {
    const v = dig(data, pathKey);
    if (typeof v !== 'number' || Number.isNaN(v)) continue;
    facts.push({
      rawSourceId,
      ticker,
      metricName: def.metricName,
      value: def.pct ? v * 100 : def.divideBy100 ? v / 100 : v,
      unit: def.unit,
      period: new Date().toISOString().slice(0, 10),
      extractedBy: 'YAHOO_FIELD_MAP',
    });
  }
  return facts;
}

// earningsTrend.trend is an array (one entry per forecast period: '0q'/'+1q'/'0y'/'+1y', occasionally
// past periods too) — too shaped-differently from the flat dotted-path YAHOO_FIELD_MAP above to reuse
// it, so this walks the array directly. Only revenueEstimate/earningsEstimate exist in this module —
// Yahoo has no ebitda/fcf consensus at all, and no stdDev — see lib/report/estimates.ts, which is the
// only place these facts get consumed, for how that shapes what's actually derivable downstream.
// `period` is the estimate's target endDate (e.g. the quarter/fiscal-year being forecast), NOT
// today's date the way mapYahooFacts's snapshot facts use `period` — this is what a consumer sorts/
// labels periods by.
export function mapYahooEarningsTrendFacts(data: any, rawSourceId: string, ticker: string) {
  const facts: any[] = [];
  const trend = data?.earningsTrend?.trend ?? [];

  const push = (metricName: string, value: unknown, unit: string, period: string) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    facts.push({ rawSourceId, ticker, metricName, value, unit, period, extractedBy: 'YAHOO_EARNINGS_TREND' });
  };

  for (const t of trend) {
    if (!t?.endDate) continue;
    const period = new Date(t.endDate).toISOString().slice(0, 10);
    if (t.revenueEstimate) {
      push('Revenue Estimate (Avg)', t.revenueEstimate.avg, 'currency', period);
      push('Revenue Estimate (High)', t.revenueEstimate.high, 'currency', period);
      push('Revenue Estimate (Low)', t.revenueEstimate.low, 'currency', period);
      push('Revenue Estimate (# Analysts)', t.revenueEstimate.numberOfAnalysts, 'count', period);
    }
    if (t.earningsEstimate) {
      push('EPS Estimate (Avg)', t.earningsEstimate.avg, 'currency', period);
      push('EPS Estimate (High)', t.earningsEstimate.high, 'currency', period);
      push('EPS Estimate (Low)', t.earningsEstimate.low, 'currency', period);
      push('EPS Estimate (# Analysts)', t.earningsEstimate.numberOfAnalysts, 'count', period);
    }
  }
  return facts;
}

// ---------- Orchestrator ----------

export interface IngestResult {
  ticker: string;
  exchange: Exchange;
  yahooTicker: string;
  yahooData?: any;
  rawSources: any[];
  facts: any[];
  warnings: string[];
  gate0: { source: string; years: number | string[]; passed: boolean };
}

export async function ingest(ticker: string): Promise<IngestResult> {
  const ex = detectExchange(ticker);
  const yTicker = toYahooTicker(ticker, ex);

  const result: IngestResult = {
    ticker, exchange: ex, yahooTicker: yTicker,
    rawSources: [], facts: [], warnings: [],
    gate0: { source: '', years: 0, passed: false },
  };

  // ทุกตลาดดึง Yahoo เป็นฐาน ratios
  try {
    const y = await archiveYahoo(yTicker);
    result.rawSources.push(y.rawSource);
    result.yahooData = y.data;
  } catch (e) {
    result.warnings.push(`Yahoo ล้มเหลว (${yTicker}): ${(e as Error).message}`);
  }

  if (ex === 'SEC') {
    const s = await archiveSec(yTicker);
    result.rawSources.push(s.rawSource);
    result.facts.push(...s.facts);
    result.gate0 = { source: 'SEC', years: s.yearsAvailable, passed: s.yearsAvailable >= 3 };

  } else if (ex === 'HKEX') {
    try {
      const filings = await searchFilings(ticker);
      const cov = checkCoverage(filings, 3);
      result.gate0 = { source: 'HKEX', years: cov.years, passed: cov.passed };

      const annuals = filings
        .filter(f => isAnnualReportTitle(f.title))
        .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))
        .slice(0, 3);
      for (const f of annuals) {
        result.rawSources.push(await archiveHkexFiling(ticker, f));
      }
    } catch (e) {
      result.warnings.push(`HKEX ล้มเหลว: ${(e as Error).message}`);
      result.gate0 = { source: 'HKEX', years: 0, passed: false };
    }

  } else {
    const th = await archiveThai(ticker);
    result.rawSources.push(...th.rawSources);
    result.facts.push(...th.facts);
    result.warnings.push(...th.warnings);
    result.gate0 = th.gate0;
  }

  return result;
}
