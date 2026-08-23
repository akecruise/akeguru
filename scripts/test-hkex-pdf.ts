/**
 * Phase 2 smoke test for the HKEX Playwright search + PDF text-extraction pipeline.
 *   npx tsx scripts/test-hkex-pdf.ts [ticker]
 *
 * Launches a real (headless) browser against hkexnews.hk — takes ~20-40s, not part of `npm run refresh`.
 */
import { searchFilings, checkCoverage, archiveHkexFiling, isAnnualReportTitle } from "../lib/data/input-sources/hkex";
import { extractPdfText } from "../lib/data/input-sources/pdf";

async function main() {
  const ticker = process.argv[2] ?? "1773.HK";
  console.log(`searching HKEX filings for ${ticker}...`);
  const filings = await searchFilings(ticker);
  console.log(`found ${filings.length} filings total`);

  const annuals = filings
    .filter((f) => isAnnualReportTitle(f.title))
    .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  console.log(`annual reports found: ${annuals.length}`);
  for (const a of annuals) console.log(`  ${a.releaseDate}  ${a.title}  ${a.pdfUrl}`);

  const cov = checkCoverage(filings, 3);
  console.log("coverage:", cov);

  if (!annuals.length) {
    console.log("no annual report to archive/extract, stopping here");
    return;
  }

  const latest = annuals[0];
  console.log(`\narchiving latest annual report: ${latest.title}`);
  const archived = await archiveHkexFiling(ticker, latest);
  console.log("archived to:", archived.filePath, "hash:", archived.sha256Hash.slice(0, 12));

  console.log("\nextracting text...");
  const extracted = await extractPdfText(archived.filePath);
  console.log(`numPages=${extracted.numPages} totalTextLength=${extracted.text.length}`);
  console.log("first 500 chars of page 1:\n", extracted.pages[0]?.slice(0, 500));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
