/**
 * HKEX — hkexnews.hk
 *
 * ต่างจาก SEC ตรงที่ HKEX ไม่มี XBRL API สาธารณะ
 * ได้แค่ "รายการ filing + ลิงก์ PDF" เท่านั้น ตัวเลขต้อง parse จาก PDF เอง
 *
 * กลยุทธ์:
 *   ตัวเลข ratios/ราคา  -> เอาจาก yahoo-finance2 (เร็ว ฟรี structured)
 *   PDF งบฉบับเต็ม      -> เอาจากที่นี่ ใช้เป็น "ต้นฉบับ" ให้ Gate 6 ตรวจสอบ
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { chromium } from 'playwright';

const SEARCH_URL = 'https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface HkexFiling {
  stockCode: string;      // '01773'
  companyName: string;
  title: string;          // 'Annual Report 2025'
  docType: string;
  releaseDate: string;    // '2025-11-20'
  pdfUrl: string;
}

/** normalize: '1773.HK' | '1773' | 'SEHK:1773'  ->  '01773' */
export function toStockCode(input: string): string {
  const digits = input.replace(/[^0-9]/g, '');
  if (!digits) throw new Error(`stock code ไม่ถูกต้อง: ${input}`);
  return digits.padStart(5, '0');
}

/**
 * ค้นหา filing ผ่าน Playwright — ไม่ใช่ plain POST เพราะหน้า search จริงเป็น JSF/PrimeFaces
 * ViewState form (ต้องมี session token จาก GET ก่อน) ไม่รับ POST ตรงๆ แบบ static form-encode
 * (ยืนยันแล้วระหว่าง Phase -1: POST ตรงได้แค่หน้าฟอร์มเปล่ากลับมา ไม่ใช่ผลค้นหา)
 *
 * ผลลัพธ์โหลดแบบ progressive (ไม่ใช่ pagination ปุ่มเดียว) — poll ด้วย wait สั้นๆ หลายรอบ
 * จนกว่าจะเจอ annual report ครบ minAnnualReports หรือครบ maxRounds
 */
export async function searchFilings(
  ticker: string,
  opts: { from?: Date; minAnnualReports?: number; maxRounds?: number } = {}
): Promise<HkexFiling[]> {
  const code = toStockCode(ticker);
  const from = opts.from ?? new Date(Date.now() - 6 * 365 * 24 * 60 * 60 * 1000);
  const minAnnualReports = opts.minAnnualReports ?? 3;
  // A prolific filer (frequent director-dealing/disclosure filings) can crowd out older Annual
  // Reports for a while as results load progressively — 12 rounds x 2s was enough in testing to
  // surface 2+ years back even for such tickers. This is a batch script, not a request-time path.
  const maxRounds = opts.maxRounds ?? 12;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: DESKTOP_UA, viewport: { width: 1280, height: 2000 } });
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);

    const acceptCookies = page.locator('#onetrust-accept-btn-handler');
    if (await acceptCookies.isVisible().catch(() => false)) await acceptCookies.click();
    await page.waitForTimeout(300);

    // "From" date is a readonly field driven by a year/month/day scroll-picker widget, not a text input
    await page.click('#searchDate-From');
    await page.waitForTimeout(400);
    await page.click(`.datetime-picker .year button[data-value='${from.getFullYear()}']`);
    await page.click(`.datetime-picker .month button[data-value='${from.getMonth()}']`);
    await page.click(`.datetime-picker .day button[data-value='${from.getDate()}']`);
    // the visible "SET" button wraps a jQuery-Mobile-enhanced hidden <button id="set-btn">
    // that Playwright's actionability check treats as not-visible; dispatch a raw click instead
    await page.evaluate(() => document.querySelector<HTMLElement>('#set-btn')?.click());
    await page.waitForTimeout(400);

    // stock code must be picked from the autocomplete dropdown — typing alone doesn't set
    // the hidden stockId/stockCode fields the search actually reads. The dropdown itself
    // depends on a client-side stock-list JSON that loads asynchronously after page load,
    // so typing too early races it (confirmed during Phase 2 dev — poll instead of a fixed wait).
    await page.click('#searchStockCode');
    await page.keyboard.type(String(Number(code)), { delay: 100 });

    const suggestionRow = page
      .locator('tr.autocomplete-suggestion:not(.suggestion-viewall)')
      .filter({ hasText: code });
    await suggestionRow.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if ((await suggestionRow.count()) === 0) {
      throw new Error(`HKEX autocomplete ไม่เจอ stock code ${code}`);
    }
    await suggestionRow.first().click();
    await page.waitForTimeout(400);

    await page.click('a.filter__btn-applyFilters-js');

    // first page renders ~100 rows; older filings (older Annual Reports for a prolific filer)
    // need an explicit "Load more" click each round — it's a real link, not scroll/intersection-triggered
    const loadMore = page.locator('a.component-loadmore__link');

    let rows: HkexFiling[] = [];
    for (let i = 0; i < maxRounds; i++) {
      await page.waitForTimeout(2000);
      rows = await extractRows(page, code);
      const annualCount = rows.filter((r) => /annual report/i.test(r.title)).length;
      if (annualCount >= minAnnualReports) break;

      if (await loadMore.isVisible().catch(() => false)) {
        await loadMore.click();
      } else {
        break; // no more pages left to load
      }
    }
    return rows;
  } finally {
    await browser.close();
  }
}

async function extractRows(page: import('playwright').Page, code: string): Promise<HkexFiling[]> {
  return page.evaluate((stockCode) => {
    const out: {
      stockCode: string;
      companyName: string;
      title: string;
      docType: string;
      releaseDate: string;
      pdfUrl: string;
    }[] = [];
    for (const tr of document.querySelectorAll('table.table tbody tr')) {
      const link = tr.querySelector('.doc-link a') as HTMLAnchorElement | null;
      if (!link) continue;
      const dateCell = tr.querySelector('td.release-time')?.textContent ?? '';
      const d = /(\d{2})\/(\d{2})\/(\d{4})/.exec(dateCell);
      const companyName = tr.querySelector('td.stock-short-name')?.textContent?.replace('Stock Short Name:', '').trim() ?? '';
      const docType = tr.querySelector('.headline')?.textContent?.trim() ?? '';
      out.push({
        stockCode,
        companyName,
        title: link.textContent?.trim() ?? '',
        docType,
        releaseDate: d ? `${d[3]}-${d[2]}-${d[1]}` : '',
        pdfUrl: link.href,
      });
    }
    return out;
  }, code);
}

/**
 * Matches the actual Annual Report filing title ('2025 Annual Report'), not any document that
 * merely mentions "the Annual Report" in passing (e.g. an interim-results announcement that
 * references a prior year's annual report) — confirmed as a real false-positive risk with
 * /annual report/i against 1773.HK's filing history during Phase 2 testing.
 */
export function isAnnualReportTitle(title: string): boolean {
  return /^\d{4}\s+annual\s+report$/i.test(title.trim());
}

/** โหลด PDF + hash + คืนข้อมูลสำหรับ insert RawSource */
export async function archiveHkexFiling(
  ticker: string,
  filing: HkexFiling,
  rootDir = 'raw-sources'
) {
  const res = await fetch(filing.pdfUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) throw new Error(`โหลด PDF ไม่ได้: ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex');

  const dir = path.join(rootDir, 'HKEX', toStockCode(ticker), filing.releaseDate);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, sanitize(filing.title) + '.pdf');
  await fs.writeFile(filePath, buf);

  return {
    ticker,
    market: 'HKEX' as const,
    filePath,
    sha256Hash: hash,
    fiscalPeriod: filing.releaseDate.slice(0, 4),
    fetchedBy: 'hkex.ts',
    fetchedAt: new Date(),
    sourceUrl: filing.pdfUrl,
    title: filing.title,
  };
}

function sanitize(s: string) {
  return s.replace(/[^\w\u4e00-\u9fff\- ]/g, '').replace(/\s+/g, '_').slice(0, 80) || 'filing';
}

/** Gate 0 — มี annual report อย่างน้อย N ปีไหม */
export function checkCoverage(filings: HkexFiling[], minYears = 3) {
  const years = new Set(filings.map(f => f.releaseDate.slice(0, 4)).filter(Boolean));
  return { years: [...years].sort(), passed: years.size >= minYears };
}
