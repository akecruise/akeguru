/**
 * Single-file progress state (logs/status.json) so a run with no console attached (Windows Task
 * Scheduler) can be watched live (scripts/watch-status.ps1) or diagnosed after the fact without
 * re-reading a whole log file. Written by whichever pipeline actually runs unattended today --
 * lib/refresh.ts's runRefresh() -- not the Compound OS agent pipeline (scripts/run-report.ts),
 * which stays on-demand/manual per the README and isn't scheduled.
 */
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import path from "path";

const LOG_DIR = path.join(__dirname, "..", "logs");
const STATUS_PATH = path.join(LOG_DIR, "status.json");

export interface RunStatus {
  runId: string;
  startedAt: string;
  updatedAt: string;
  currentStage: string;
  stage: number;
  totalStages: number;
  tickersDone: number;
  tickersTotal: number;
  status: "running" | "done" | "failed";
  lastError: string | null;
}

function load(): Partial<RunStatus> {
  try {
    return JSON.parse(readFileSync(STATUS_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Merges `patch` over whatever's already on disk, so a call site only has to pass the fields
 *  it's actually updating, and always stamps `updatedAt` -- the field a watcher (scripts/
 *  watch-status.ps1, the ntfy step) needs to tell "still running" apart from "crashed and nobody
 *  wrote the final status". */
export function report(patch: Partial<RunStatus>): void {
  mkdirSync(LOG_DIR, { recursive: true });
  const next = { ...load(), ...patch, updatedAt: new Date().toISOString() } as RunStatus;
  writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2), "utf8");
}
