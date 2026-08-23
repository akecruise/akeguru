/**
 * SEC EDGAR — ฟรี ไม่ต้อง API key
 * บังคับ: ต้องใส่ User-Agent เป็นชื่อ+อีเมลจริง ไม่งั้นโดนบล็อก
 * Rate limit: 10 req/วินาที
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const UA = process.env.SEC_USER_AGENT || 'akeguru ake@example.com';
const HEADERS = { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' };

// ---------- 1. ticker -> CIK ----------

let cikCache: Map<string, string> | null = null;

export async function getCik(ticker: string): Promise<string | null> {
  if (!cikCache) {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: HEADERS });
    const json = await res.json() as Record<string, { cik_str: number; ticker: string }>;
    cikCache = new Map(
      Object.values(json).map(v => [v.ticker.toUpperCase(), String(v.cik_str).padStart(10, '0')])
    );
  }
  return cikCache.get(ticker.toUpperCase()) ?? null;
}

// ---------- 2. ดึง facts ทั้งหมด (XBRL) ----------

export interface SecFactRow {
  metricName: string;   // 'Revenues', 'StockholdersEquity', ...
  value: number;
  unit: string;         // 'USD', 'shares'
  period: string;       // '2025-12-31'
  fiscalYear: number;
  fiscalPeriod: string; // 'FY' | 'Q1' ...
  form: string;         // '10-K' | '10-Q'
  filedAt: string;
  accession: string;    // ใช้ trace กลับไปหา filing ต้นฉบับ
}

/** ดึง companyfacts ทั้งก้อน — เป็น "raw" ที่จะเซฟลง disk */
export async function fetchCompanyFacts(cik: string) {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`SEC ${res.status} for CIK${cik}`);
  return res.json();
}

/** แปลง companyfacts -> แถวแบน พร้อม insert FinancialFact */
export function flattenFacts(raw: any, opts?: { taxonomy?: string }): SecFactRow[] {
  const tax = opts?.taxonomy ?? 'us-gaap';
  const out: SecFactRow[] = [];
  const concepts = raw?.facts?.[tax] ?? {};

  for (const [metricName, node] of Object.entries<any>(concepts)) {
    for (const [unit, entries] of Object.entries<any[]>(node?.units ?? {})) {
      for (const e of entries) {
        if (e.val == null || !e.end) continue;
        out.push({
          metricName,
          value: Number(e.val),
          unit,
          period: e.end,
          fiscalYear: e.fy,
          fiscalPeriod: e.fp,
          form: e.form,
          filedAt: e.filed,
          accession: e.accn,
        });
      }
    }
  }
  return out;
}

/** เอาเฉพาะงบปี (10-K) ล่าสุด N ปี ของ metric ที่สนใจ */
export const CORE_METRICS = [
  'Revenues',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'OperatingIncomeLoss',
  'NetIncomeLoss',
  'Assets',
  'Liabilities',
  'StockholdersEquity',
  'CashAndCashEquivalentsAtCarryingValue',
  'LongTermDebtNoncurrent',
  'EarningsPerShareDiluted',
  'NetCashProvidedByUsedInOperatingActivities',
  'PaymentsToAcquirePropertyPlantAndEquipment',
] as const;

/** BS/IS/CF classification per CORE_METRICS tag -- consumed by scripts/ingest.ts to populate
 *  FinancialFact.statement for SEC-sourced facts. (th.ts's ThFinancialRow already carries its own
 *  statementType from the ก.ล.ต. financial_statement field directly; this table exists because
 *  SecFactRow has no equivalent field of its own.) */
export const STATEMENT_BY_TAG: Record<(typeof CORE_METRICS)[number], 'BS' | 'IS' | 'CF'> = {
  Revenues: 'IS',
  RevenueFromContractWithCustomerExcludingAssessedTax: 'IS',
  OperatingIncomeLoss: 'IS',
  NetIncomeLoss: 'IS',
  EarningsPerShareDiluted: 'IS',
  Assets: 'BS',
  Liabilities: 'BS',
  StockholdersEquity: 'BS',
  CashAndCashEquivalentsAtCarryingValue: 'BS',
  LongTermDebtNoncurrent: 'BS',
  NetCashProvidedByUsedInOperatingActivities: 'CF',
  PaymentsToAcquirePropertyPlantAndEquipment: 'CF',
};

/** Only EarningsPerShareDiluted is a per-share figure among CORE_METRICS -- everything else is a
 *  total/balance that a split doesn't affect. SEC/XBRL facts are as-filed historical figures, not
 *  verified against a split that may have happened since, so this is false (not "unknown"/null)
 *  rather than true the way a live Yahoo fact would be -- see FinancialFact.splitAdjusted's schema
 *  comment for the true/false/null distinction. */
export const SPLIT_ADJUSTED_BY_TAG: Partial<Record<(typeof CORE_METRICS)[number], boolean>> = {
  EarningsPerShareDiluted: false,
};

export function selectAnnual(rows: SecFactRow[], years = 5): SecFactRow[] {
  const wanted = new Set<string>(CORE_METRICS);
  const seen = new Set<string>();
  return rows
    .filter(r => wanted.has(r.metricName) && r.form === '10-K' && r.fiscalPeriod === 'FY')
    .sort((a, b) => b.period.localeCompare(a.period))
    .filter(r => {
      const key = `${r.metricName}|${r.period}`;
      if (seen.has(key)) return false;   // กัน amendment ซ้ำ เอาอันที่ filed ล่าสุด
      seen.add(key);
      return true;
    })
    .filter(r => Number(r.period.slice(0, 4)) >= new Date().getFullYear() - years);
}

// ---------- 3. archive -> RawSource ----------

export async function archiveSec(ticker: string, rootDir = 'raw-sources') {
  const cik = await getCik(ticker);
  if (!cik) throw new Error(`ไม่พบ CIK ของ ${ticker}`);

  const raw = await fetchCompanyFacts(cik);
  const body = JSON.stringify(raw);
  const hash = crypto.createHash('sha256').update(body).digest('hex');

  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(rootDir, 'SEC', ticker, day);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'companyfacts.json');
  await fs.writeFile(filePath, body);

  const rows = selectAnnual(flattenFacts(raw));

  return {
    rawSource: {
      ticker,
      market: 'SEC' as const,
      filePath,
      sha256Hash: hash,
      fetchedBy: 'sec.ts',
      fetchedAt: new Date(),
      cik,
    },
    facts: rows,
    // Gate 0
    yearsAvailable: new Set(rows.map(r => r.period.slice(0, 4))).size,
  };
}
