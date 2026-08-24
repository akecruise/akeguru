/**
 * On-demand wrapper for the "Analyze this stock" button (app/api/stock/[ticker]/analyze) -- runs
 * ingest.ts then run-report.ts sequentially for one ticker, tracking progress in
 * logs/analyze/<TICKER>.json (lib/analyze-status.ts) so the UI can poll instead of holding an HTTP
 * request open for the ~10-15 minutes the full agent pipeline takes.
 *
 * Spawned from app/api/stock/[ticker]/analyze/route.ts and left running independently of that HTTP
 * request/response cycle -- the Next.js server process itself stays alive regardless of any single
 * request finishing, so this doesn't need to be `detached` from it (only a full server restart
 * during active development would kill it, the same risk as running any of these scripts by hand
 * in a terminal you close).
 *
 *   npx tsx scripts/analyze-ticker.ts MSFT
 */
import { spawnSync } from "child_process";
import { writeAnalyzeStatus } from "../lib/analyze-status";

function main() {
  const ticker = process.argv[2];
  if (!ticker) {
    console.error("usage: npx tsx scripts/analyze-ticker.ts <TICKER>");
    process.exitCode = 1;
    return;
  }

  const startedAt = new Date().toISOString();
  writeAnalyzeStatus({ ticker, status: "running", startedAt, finishedAt: null, error: null });

  const ingestResult = spawnSync("npx", ["tsx", "scripts/ingest.ts", ticker], { stdio: "inherit", shell: true });
  if (ingestResult.status !== 0) {
    writeAnalyzeStatus({ ticker, status: "failed", startedAt, finishedAt: new Date().toISOString(), error: "ingest.ts failed -- see logs/analyze for this run's output" });
    process.exitCode = 1;
    return;
  }

  // run-report.ts only exits non-zero on a genuine pipeline failure (report didn't validate) -- a
  // REJECTED gateStatus is a normal, valid outcome it exits 0 for (see that script's own doc
  // comment), so this correctly doesn't treat "rejected" as "failed."
  const reportResult = spawnSync("npx", ["tsx", "scripts/run-report.ts", ticker], { stdio: "inherit", shell: true });
  if (reportResult.status !== 0) {
    writeAnalyzeStatus({ ticker, status: "failed", startedAt, finishedAt: new Date().toISOString(), error: "run-report.ts failed -- see logs/analyze for this run's output" });
    process.exitCode = 1;
    return;
  }

  writeAnalyzeStatus({ ticker, status: "done", startedAt, finishedAt: new Date().toISOString(), error: null });
}

main();
