/**
 * Per-ticker status file for the on-demand "Analyze this stock" trigger
 * (app/api/stock/[ticker]/analyze) -- same file-based reasoning as lib/progress.ts's
 * logs/status.json, but keyed per ticker (one file each, logs/analyze/<TICKER>.json) since
 * multiple analyze requests can be in flight independently, unlike the single global refresh job
 * lib/progress.ts tracks.
 *
 * Exists because the full agent pipeline (ingest + 7 sequential agent calls) takes ~10-15 minutes
 * -- far too long to hold an HTTP request open for. The API route starts scripts/analyze-ticker.ts
 * in the background and returns immediately; the UI polls this status instead.
 */
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import path from "path";

// process.cwd(), not __dirname: this module is imported both from plain tsx-executed scripts
// (where __dirname is the real source location) AND from the Next.js app itself (API route, stock
// page) where the bundler rewrites __dirname to somewhere under .next/, not the project root --
// confirmed live, the analyze button stayed stuck on "Analyzing..." forever because the app was
// reading a status file at the wrong path while scripts/analyze-ticker.ts wrote to the real one.
// process.cwd() is stable across both contexts since both are always started from the project root.
const ANALYZE_DIR = path.join(process.cwd(), "logs", "analyze");

export interface AnalyzeStatus {
  ticker: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

// Callers always pass an already-validated ticker (looked up as a real Stock.ticker from the DB
// before this is ever called -- see the API route) -- never raw, unchecked user input -- so there's
// no path-traversal risk in using it directly as a filename here.
function statusPath(ticker: string): string {
  return path.join(ANALYZE_DIR, `${ticker}.json`);
}

export function readAnalyzeStatus(ticker: string): AnalyzeStatus | null {
  try {
    return JSON.parse(readFileSync(statusPath(ticker), "utf8"));
  } catch {
    return null;
  }
}

export function writeAnalyzeStatus(status: AnalyzeStatus): void {
  mkdirSync(ANALYZE_DIR, { recursive: true });
  writeFileSync(statusPath(status.ticker), JSON.stringify(status, null, 2));
}
