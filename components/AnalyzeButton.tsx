"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export interface AnalyzeStatus {
  ticker: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

const POLL_MS = 20_000; // the full pipeline takes ~10-15 min -- no need to poll faster than this

export function AnalyzeButton({
  ticker,
  hasReport,
  initialStatus,
}: {
  ticker: string;
  hasReport: boolean;
  initialStatus: AnalyzeStatus | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (status?.status !== "running") return;
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/stock/${ticker}/analyze`);
      if (!res.ok) return; // transient error -- try again next tick, don't spam the error state over a single missed poll
      const body = (await res.json()) as { status: AnalyzeStatus | null };
      if (body.status) {
        setStatus(body.status);
        if (body.status.status !== "running") {
          router.refresh(); // picks up the new ResearchReport (or shows the failure) without a full reload
        }
      }
    }, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status?.status, ticker, router]);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/stock/${ticker}/analyze`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not start analysis.");
        return;
      }
      setStatus({ ticker, status: "running", startedAt: body.startedAt, finishedAt: null, error: null });
    } finally {
      setPending(false);
    }
  }

  const isRunning = status?.status === "running";

  return (
    <div>
      <button
        onClick={start}
        disabled={pending || isRunning}
        className="rounded-md border border-card-border px-3 py-1.5 text-sm font-medium hover:bg-black/[.03] disabled:opacity-60 dark:hover:bg-white/[.05]"
      >
        {isRunning ? "Analyzing… (~10-15 min)" : hasReport ? "Re-run analysis" : "Analyze this stock"}
      </button>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {status?.status === "failed" && !error && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">Analysis failed: {status.error}</p>
      )}
    </div>
  );
}
