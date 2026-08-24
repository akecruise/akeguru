/**
 * CCASS shareholding search — www3.hkexnews.hk/sdw/search/searchsdw.aspx
 *
 * Same shape of problem as hkex.ts's filing search: confirmed via the Performance Resource
 * Timing API (no XHR/fetch to searchsdw.aspx appears when clicking Search — it's a full-page
 * navigation) plus a real __VIEWSTATE hidden field in the form, that this is a classic ASP.NET
 * WebForms postback, not a JSON API to hit directly with fetch(). Uses Playwright, same
 * proven-working approach as hkex.ts, instead of trying to replay VIEWSTATE over raw HTTP.
 *
 * This is CCASS *shareholding* (who holds the stock, through which broker/participant) —
 * NOT short interest. HKEX/CCASS doesn't publish short positions; that's a separate SFC
 * disclosure regime this module doesn't cover.
 *
 * Doesn't persist every participant row (~130/ticker/day, mostly static broker addresses, low
 * marginal research value to keep forever) — scripts/fetch-ccass.ts derives and stores real
 * concentration stats (top-1/top-10 % of issued shares) plus the top 10 holders themselves,
 * which is what's actually useful for personal research: is ownership concentrated in a couple
 * of brokers (margin-financing/block-holder risk) or diffuse.
 */
import { chromium } from "playwright";
import { toStockCode } from "./hkex";

const SEARCH_URL = "https://www3.hkexnews.hk/sdw/search/searchsdw.aspx";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface CcassHolder {
  participantId: string;
  name: string;
  address: string;
  shareholding: number;
  pctOfIssued: number;
}

export interface CcassSnapshotResult {
  stockCode: string; // '01773'
  asOfDate: string; // as shown on the page, 'YYYY/MM/DD'
  totalShareholding: number;
  totalParticipants: number;
  totalPctOfIssued: number;
  totalIssuedShares: number;
  holders: CcassHolder[]; // every participant row as scraped, unsorted
}

/** Defaults to the site's own most-recent-available date (whatever #txtShareholdingDate is
 *  pre-filled with on load) -- doesn't touch the date picker widget, same "don't replicate a
 *  finicky scroll-picker unless you need to" reasoning hkex.ts's date field required for a
 *  *range* search, which this single-date lookup doesn't need. */
export async function fetchCcassSnapshot(ticker: string): Promise<CcassSnapshotResult> {
  const code = toStockCode(ticker);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: DESKTOP_UA, viewport: { width: 1280, height: 2000 } });
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(800);

    const declineCookies = page.locator("button:has-text('Decline')");
    if (await declineCookies.isVisible().catch(() => false)) await declineCookies.click().catch(() => {});
    await page.waitForTimeout(200);

    await page.fill("#txtStockCode", code);
    await page.click("#btnSearch");
    await page.waitForSelector(".ccass-search-total", { timeout: 20000 });
    await page.waitForTimeout(500);

    // Raw string extraction only inside evaluate() -- a named const arrow function in this
    // callback (e.g. a `num()` parse helper) triggers tsx/esbuild's injected __name() reference-
    // preservation call, which doesn't exist in the page's isolated evaluate context (confirmed
    // live: "ReferenceError: __name is not defined"). All numeric parsing happens below instead.
    const raw = await page.evaluate(() => {
      const totalEl = document.querySelector(".ccass-search-total");
      const totalValues = totalEl ? [...totalEl.querySelectorAll(".value")].map((v) => v.textContent?.trim() ?? "") : [];
      const issuedSharesText = document.querySelector(".summary-value")?.textContent?.trim() ?? "0";
      const asOfDate = (document.querySelector("#txtShareholdingDate") as HTMLInputElement | null)?.value ?? "";

      // Each <td> is a responsive "table-mobile-list" cell whose textContent is "Label:\nValue\n"
      // (a trailing newline, confirmed live -- a naive .split("\n").pop() grabs that trailing
      // empty string, not the value). Split, trim each line, drop empties, take the last real one.
      const holders = [...document.querySelectorAll("table.table-scroll tbody tr")]
        .map((tr) =>
          [...tr.querySelectorAll("td")].map(
            (td) => (td.textContent ?? "").split("\n").map((s) => s.trim()).filter(Boolean).pop() ?? "",
          ),
        )
        .filter((cells) => cells[0]);

      return { totalValues, issuedSharesText, asOfDate, holders };
    });

    const num = (s: string) => Number(s.replace(/[,%]/g, ""));
    const holders: CcassHolder[] = raw.holders.map((cells) => ({
      participantId: cells[0] ?? "",
      name: cells[1] ?? "",
      address: cells[2] ?? "",
      shareholding: num(cells[3] ?? "0"),
      pctOfIssued: num(cells[4] ?? "0"),
    }));

    return {
      stockCode: code,
      asOfDate: raw.asOfDate,
      totalShareholding: raw.totalValues[0] ? num(raw.totalValues[0]) : 0,
      totalParticipants: raw.totalValues[1] ? num(raw.totalValues[1]) : 0,
      totalPctOfIssued: raw.totalValues[2] ? num(raw.totalValues[2]) : 0,
      totalIssuedShares: num(raw.issuedSharesText),
      holders,
    };
  } finally {
    await browser.close();
  }
}

/** Real ownership-concentration stats derived from the scraped holder rows -- % of *issued*
 *  shares (not just % of the CCASS-held pool), so it's comparable across tickers regardless of
 *  how much of each one's float sits in CCASS at all. */
export function computeConcentration(holders: CcassHolder[]): { top1PctOfIssued: number | null; top10PctOfIssued: number | null; topHolders: CcassHolder[] } {
  const sorted = [...holders].sort((a, b) => b.shareholding - a.shareholding);
  const top10 = sorted.slice(0, 10);
  return {
    top1PctOfIssued: sorted[0]?.pctOfIssued ?? null,
    top10PctOfIssued: top10.length ? top10.reduce((s, h) => s + h.pctOfIssued, 0) : null,
    topHolders: top10,
  };
}
