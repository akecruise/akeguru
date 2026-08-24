import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { openSync, mkdirSync } from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth/session";
import { readAnalyzeStatus, writeAnalyzeStatus } from "@/lib/analyze-status";

async function loadStock(rawTicker: string) {
  const ticker = decodeURIComponent(rawTicker).toUpperCase();
  return prisma.stock.findUnique({ where: { ticker } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { ticker } = await params;
  const stock = await loadStock(ticker);
  if (!stock) return NextResponse.json({ error: "Unknown ticker" }, { status: 404 });

  return NextResponse.json({ status: readAnalyzeStatus(stock.ticker) });
}

/**
 * Starts scripts/analyze-ticker.ts (ingest + full agent pipeline, ~10-15 min) in the background and
 * returns immediately -- see that script's doc comment for why this doesn't need to be `detached`.
 * stdout/stderr go to a timestamped log file (logs/analyze/<TICKER>-<timestamp>.log), same
 * "always leave a real log behind" convention as scripts/run-refresh-task.ps1, not silently
 * discarded -- a failure 10 minutes into a real run needs to be debuggable after the fact.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { ticker: rawTicker } = await params;
  const stock = await loadStock(rawTicker);
  if (!stock) return NextResponse.json({ error: "Unknown ticker" }, { status: 404 });

  const existing = readAnalyzeStatus(stock.ticker);
  if (existing?.status === "running") {
    return NextResponse.json({ error: "Analysis is already running for this ticker" }, { status: 409 });
  }

  const startedAt = new Date().toISOString();
  writeAnalyzeStatus({ ticker: stock.ticker, status: "running", startedAt, finishedAt: null, error: null });

  const projectRoot = process.cwd();
  const logDir = path.join(projectRoot, "logs", "analyze");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${stock.ticker}-${Date.now()}.log`);
  const logFd = openSync(logPath, "a");

  const child = spawn("npx", ["tsx", "scripts/analyze-ticker.ts", stock.ticker], {
    cwd: projectRoot,
    stdio: ["ignore", logFd, logFd],
    shell: true,
  });
  child.on("error", (err) => {
    writeAnalyzeStatus({ ticker: stock.ticker, status: "failed", startedAt, finishedAt: new Date().toISOString(), error: `failed to start: ${err.message}` });
  });

  return NextResponse.json({ started: true, startedAt });
}
