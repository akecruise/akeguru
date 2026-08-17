"use client";

import { useState } from "react";

export interface DeepReportData {
  content: string;
  model: string;
  createdAt: string;
}

export function DeepReportPanel({
  ticker,
  initialReport,
  signedIn,
}: {
  ticker: string;
  initialReport: DeepReportData | null;
  signedIn: boolean;
}) {
  const [report, setReport] = useState(initialReport);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/stock/${ticker}/deep-report`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not generate report.");
        return;
      }
      setReport(body.report);
    } finally {
      setPending(false);
    }
  }

  if (!signedIn) {
    return (
      <p className="text-sm text-black/50 dark:text-white/50">
        Sign in to generate an AI deep-dive report for this stock.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-black/50 dark:text-white/50">
          {report
            ? `Generated ${new Date(report.createdAt).toLocaleString()} by ${report.model}`
            : "Calls the Anthropic API on your own key — not run automatically."}
        </p>
        <button
          onClick={generate}
          disabled={pending}
          className="shrink-0 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-60"
        >
          {pending ? "Generating…" : report ? "Regenerate report" : "Generate report"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {report && (
        <div className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-black/80 dark:text-white/80">
          {report.content}
        </div>
      )}
    </div>
  );
}
