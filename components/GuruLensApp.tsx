"use client";

import { useState } from "react";
import Link from "next/link";
import { ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceDot } from "recharts";
import { Badge, StampBadge } from "@/components/ui/Badge";
import { AnalyzeButton, type AnalyzeStatus } from "@/components/AnalyzeButton";
import type { LensVerdict } from "@/lib/guru-lens";

export interface DisplayCandidate {
  id: string;
  ticker: string;
  name: string;
  sector: string | null;
  price: number | null;
  currency: string | null;
  priceChangePct1d: number | null;
  consensusScore: number | null;
  mosProxy: number | null;
  decision: "GO" | "WAIT" | "NO_GO" | null;
  conviction: number | null;
  hasReport: boolean;
  turtleConfirmed: "long" | "short" | "none" | null;
  turtleWeightPct: number | null;
  turtleN: number | null;
  turtleExitLow: number | null;
  lensResults: Record<string, { verdict: LensVerdict; reason: string }>;
  bars: { high: number; low: number; close: number }[];
  analyzeStatus: AnalyzeStatus | null;
}

interface LensMeta {
  id: string;
  name: string;
  tag: string;
  quote: string;
  rule: string;
}

const LENS_VARIANT: Record<LensVerdict, "go" | "wait" | "no_go" | "neutral" | "pending"> = {
  BUY: "go",
  WATCH: "wait",
  PASS: "neutral",
  SELL: "no_go",
  UNANALYZED: "pending",
};

const LENS_DOT: Record<LensVerdict, string> = {
  BUY: "bg-go",
  WATCH: "bg-wait",
  SELL: "bg-nogo",
  PASS: "bg-foreground/25",
  UNANALYZED: "bg-foreground/10",
};

function fmtPrice(v: number | null, currency: string | null): string {
  if (v == null) return "—";
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency ?? ""}`.trim();
}

function lastName(fullName: string): string {
  return fullName.split(" ").pop() ?? fullName;
}

function Overview({ candidates, onPick }: { candidates: DisplayCandidate[]; onPick: (t: string) => void }) {
  const sorted = [...candidates].sort((a, b) => (b.consensusScore ?? -Infinity) - (a.consensusScore ?? -Infinity));
  const counts = { GO: 0, WAIT: 0, NO_GO: 0, none: 0 };
  for (const c of candidates) counts[c.decision ?? "none"]++;
  const total = candidates.length;
  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-3 font-mono text-[11px] text-foreground-faint">
        <span className="text-go">GO {counts.GO}</span>
        <span className="text-wait">WAIT {counts.WAIT}</span>
        <span className="text-nogo">NO-GO {counts.NO_GO}</span>
        <span>ยังไม่ analyze {counts.none}</span>
      </div>
      <div className="mb-5 mt-2 flex h-2 overflow-hidden rounded-full">
        <div className="bg-go" style={{ width: `${(counts.GO / total) * 100}%` }} />
        <div className="bg-wait" style={{ width: `${(counts.WAIT / total) * 100}%` }} />
        <div className="bg-nogo" style={{ width: `${(counts.NO_GO / total) * 100}%` }} />
        <div className="bg-foreground/10" style={{ width: `${(counts.none / total) * 100}%` }} />
      </div>
      <div className="space-y-1.5">
        {sorted.map((c) => (
          <button
            key={c.ticker}
            onClick={() => onPick(c.ticker)}
            className="flex w-full items-center justify-between rounded-lg border border-card-border bg-card px-3 py-2.5 text-left transition-colors hover:border-accent/50"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="w-[74px] shrink-0 font-mono text-sm font-bold text-foreground">{c.ticker}</span>
              {c.decision ? <StampBadge text={c.decision === "NO_GO" ? "NO-GO" : c.decision} variant={c.decision === "NO_GO" ? "no_go" : (c.decision.toLowerCase() as "go" | "wait")} /> : <span className="text-[11px] text-foreground-faint">ยังไม่ analyze</span>}
            </div>
            <div className="flex items-center gap-4 font-mono text-sm">
              <span className="text-foreground-soft">{c.consensusScore != null ? c.consensusScore.toFixed(1) : "—"}</span>
              <span className={`w-[52px] text-right text-xs ${c.mosProxy == null ? "text-foreground-faint" : c.mosProxy > 0 ? "text-go" : "text-nogo"}`}>
                {c.mosProxy == null ? "—" : `${c.mosProxy > 0 ? "+" : ""}${c.mosProxy.toFixed(0)}%`}
              </span>
            </div>
          </button>
        ))}
      </div>
      <div className="mt-2 flex justify-end gap-6 pr-1 font-mono text-[10px] text-foreground-faint">
        <span>consensus score</span>
        <span>MOS proxy</span>
      </div>
    </div>
  );
}

const PageHead = ({ title, sub }: { title: string; sub: string }) => (
  <div className="mb-3">
    <h2 className="text-base font-bold text-foreground">{title}</h2>
    <p className="font-mono text-[11px] text-foreground-faint">{sub}</p>
  </div>
);

const GuruPicker = ({ lensMeta, lens, setLens }: { lensMeta: LensMeta[]; lens: string; setLens: (l: string) => void }) => (
  <div className="mb-4 flex flex-wrap gap-1.5">
    {[{ id: "consensus", label: "★ Consensus" }, ...lensMeta.map((l) => ({ id: l.id, label: lastName(l.name) }))].map(({ id, label }) => (
      <button
        key={id}
        onClick={() => setLens(id)}
        className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${lens === id ? "border-accent/60 bg-accent-soft text-accent" : "border-card-border text-foreground-faint hover:text-foreground"}`}
      >
        {label}
      </button>
    ))}
  </div>
);

function LensView({ candidates, lensMeta }: { candidates: DisplayCandidate[]; lensMeta: LensMeta[] }) {
  const [lens, setLens] = useState("consensus");
  const nGurus = lensMeta.length;

  if (lens === "consensus") {
    const matrix = candidates
      .map((c) => {
        const votes = lensMeta.map((L) => ({ id: L.id, name: lastName(L.name), ...c.lensResults[L.id] }));
        const buys = votes.filter((v) => v.verdict === "BUY").length;
        return { c, votes, buys };
      })
      .sort((a, b) => b.buys - a.buys);
    return (
      <div>
        <PageHead title="Guru Lens" sub={`${nGurus} gurus × ${candidates.length} หุ้น · เรียงตามเสียง BUY`} />
        <GuruPicker lensMeta={lensMeta} lens={lens} setLens={setLens} />
        <div className="space-y-2">
          {matrix.map(({ c, votes, buys }) => (
            <div key={c.ticker} className="rounded-lg border border-card-border bg-card p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-sm font-bold text-foreground">{c.ticker}</span>
                <span className={`font-mono text-[12px] ${buys >= 5 ? "text-go" : buys >= 3 ? "text-wait" : "text-foreground-faint"}`}>
                  {buys}/{nGurus} BUY
                </span>
              </div>
              <div className="mb-2 flex gap-1">
                {votes.map((v) => (
                  <div key={v.id} title={`${v.name}: ${v.verdict}`} className={`h-1.5 flex-1 rounded-full ${LENS_DOT[v.verdict]}`} />
                ))}
              </div>
              <div className="flex flex-wrap gap-1">
                {votes.filter((v) => v.verdict === "BUY").length === 0 ? (
                  <span className="text-[10px] text-foreground-faint">ไม่มีใครซื้อ</span>
                ) : (
                  votes
                    .filter((v) => v.verdict === "BUY")
                    .map((v) => (
                      <span key={v.id} className="font-mono text-[10px] text-go">
                        {v.name}
                      </span>
                    ))
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10px] text-foreground-faint">แถบสี = เสียงโหวตเรียงตามลำดับ guru · เขียว BUY / เหลือง WATCH / แดง SELL / เทา PASS/ยังไม่ analyze</p>
      </div>
    );
  }

  const L = lensMeta.find((l) => l.id === lens)!;
  const order: Record<LensVerdict, number> = { BUY: 0, SELL: 1, WATCH: 2, PASS: 3, UNANALYZED: 4 };
  const evaled = candidates.map((c) => ({ c, ...c.lensResults[lens] })).sort((a, b) => order[a.verdict] - order[b.verdict]);
  return (
    <div>
      <PageHead title="Guru Lens" sub={`มุมมอง ${L.name}`} />
      <GuruPicker lensMeta={lensMeta} lens={lens} setLens={setLens} />
      <div className="mb-4 rounded-lg border border-card-border bg-card p-3">
        <div className="flex items-baseline justify-between">
          <span className="font-semibold text-foreground">{L.name}</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-accent">{L.tag}</span>
        </div>
        <p className="mt-1 text-[12px] italic text-foreground-soft">&ldquo;{L.quote}&rdquo;</p>
        <p className="mt-2 font-mono text-[11px] text-foreground-faint">{L.rule}</p>
      </div>
      <div className="space-y-2">
        {evaled.map(({ c, verdict, reason }) => (
          <div key={c.ticker} className={`rounded-lg border p-3 ${verdict === "PASS" || verdict === "UNANALYZED" ? "border-card-border/60 bg-card/50" : "border-card-border bg-card"}`}>
            <div className="mb-1 flex items-center justify-between">
              <span className={`font-mono text-sm font-bold ${verdict === "PASS" || verdict === "UNANALYZED" ? "text-foreground-faint" : "text-foreground"}`}>{c.ticker}</span>
              <Badge text={verdict === "UNANALYZED" ? "N/A" : verdict} variant={LENS_VARIANT[verdict]} />
            </div>
            <p className={`text-[12px] leading-relaxed ${verdict === "PASS" || verdict === "UNANALYZED" ? "text-foreground-faint" : "text-foreground-soft"}`}>{reason}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Signals({ candidates }: { candidates: DisplayCandidate[] }) {
  const withSignal = candidates.filter((c) => c.turtleConfirmed && c.turtleConfirmed !== "none");
  return (
    <div className="space-y-2.5">
      <p className="mb-3 text-[12px] text-foreground-soft">Donchian scan (System 1: 4wk entry/2wk exit · System 2: 11wk entry/4wk exit) · N = ATR(4wk) · unit = 1% equity / N</p>
      {withSignal.length === 0 && <p className="text-[12px] text-foreground-faint">ไม่มี breakout ยืนยันวันนี้ในทั้ง universe</p>}
      {withSignal.map((c) => (
        <div key={c.ticker} className="rounded-lg border border-card-border bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono font-bold text-foreground">{c.ticker}</span>
            <span className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${c.turtleConfirmed === "long" ? "border-go/50 bg-go-bg text-go" : "border-nogo/50 bg-nogo-bg text-nogo"}`}>
              {c.turtleConfirmed === "long" ? "CONFIRMED LONG" : "CONFIRMED SHORT (avoid — long-only)"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 font-mono text-[12px]">
            <div>
              <div className="text-foreground-faint">N (ATR)</div>
              <div className="text-foreground">{c.turtleN != null ? c.turtleN.toFixed(2) : "—"}</div>
            </div>
            <div>
              <div className="text-foreground-faint">Exit level</div>
              <div className="text-foreground">{c.turtleExitLow != null ? c.turtleExitLow.toFixed(2) : "—"}</div>
            </div>
            <div>
              <div className="text-foreground-faint">Unit size</div>
              <div className="text-accent">{c.turtleWeightPct != null ? `${c.turtleWeightPct.toFixed(1)}% port` : "—"}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function buildDonchianSeries(bars: DisplayCandidate["bars"]) {
  return bars.map((_, idx) => {
    const w4 = bars.slice(Math.max(0, idx - 4), idx);
    const w11 = bars.slice(Math.max(0, idx - 11), idx);
    const w2 = bars.slice(Math.max(0, idx - 2), idx);
    return {
      w: `W${idx + 1}`,
      close: bars[idx].close,
      upper11: w11.length ? Math.max(...w11.map((b) => b.high)) : null,
      upper4: w4.length ? Math.max(...w4.map((b) => b.high)) : null,
      lower2: w2.length ? Math.min(...w2.map((b) => b.low)) : null,
    };
  });
}

function StockDetail({ candidate, lensMeta, onBack }: { candidate: DisplayCandidate; lensMeta: LensMeta[]; onBack: () => void }) {
  const series = buildDonchianSeries(candidate.bars);
  const last = series[series.length - 1];
  return (
    <div>
      <button onClick={onBack} className="mb-3 text-[12px] text-accent">
        ← กลับ Overview
      </button>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="font-mono text-xl font-bold text-foreground">{candidate.ticker}</div>
          <div className="text-[11px] text-foreground-faint">
            {candidate.name} {candidate.sector && <>· {candidate.sector}</>} · {fmtPrice(candidate.price, candidate.currency)}
          </div>
        </div>
        <div className="text-right">
          {candidate.decision ? (
            <StampBadge text={candidate.decision === "NO_GO" ? "NO-GO" : candidate.decision} variant={candidate.decision === "NO_GO" ? "no_go" : (candidate.decision.toLowerCase() as "go" | "wait")} />
          ) : (
            <AnalyzeButton ticker={candidate.ticker} hasReport={false} initialStatus={candidate.analyzeStatus} />
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {lensMeta.map((L) => {
          const r = candidate.lensResults[L.id];
          return (
            <span key={L.id} title={r.reason} className={`rounded border px-2 py-0.5 font-mono text-[10px] ${LENS_VARIANT[r.verdict] === "go" ? "border-go/40 bg-go-bg text-go" : LENS_VARIANT[r.verdict] === "wait" ? "border-wait/40 bg-wait-bg text-wait" : LENS_VARIANT[r.verdict] === "no_go" ? "border-nogo/40 bg-nogo-bg text-nogo" : "border-card-border text-foreground-faint"}`}>
              {lastName(L.name)}: {r.verdict === "UNANALYZED" ? "N/A" : r.verdict}
            </span>
          );
        })}
      </div>

      {candidate.bars.length > 5 ? (
        <>
          <div className="mb-1 font-mono text-[11px] text-foreground-faint">
            Donchian — <span className="text-go">upper 11wk (Sys.2)</span> · <span className="text-accent">upper 4wk (Sys.1)</span> · <span className="text-nogo">lower 2wk (exit)</span>
          </div>
          <div className="mb-4 rounded-lg border border-card-border bg-card p-2">
            <ResponsiveContainer width="100%" height={190}>
              <ComposedChart data={series} margin={{ top: 6, right: 4, left: -18, bottom: 0 }}>
                <XAxis dataKey="w" tick={{ fontSize: 9, fill: "var(--foreground-faint)" }} interval={Math.max(1, Math.floor(series.length / 6))} axisLine={false} tickLine={false} />
                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 9, fill: "var(--foreground-faint)" }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", fontSize: 11 }} />
                <Line dataKey="upper11" stroke="var(--go)" dot={false} strokeWidth={1.5} />
                <Line dataKey="upper4" stroke="var(--accent)" dot={false} strokeDasharray="4 3" strokeWidth={1} />
                <Line dataKey="lower2" stroke="var(--nogo)" dot={false} strokeDasharray="4 3" strokeWidth={1} />
                <Line dataKey="close" stroke="var(--foreground)" dot={false} strokeWidth={2} />
                {last && <ReferenceDot x={last.w} y={last.close} r={3.5} fill="var(--foreground)" stroke="var(--card)" />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      ) : (
        <p className="mb-4 text-[12px] text-foreground-faint">ไม่มีข้อมูลราคาพอสำหรับกราฟ Donchian</p>
      )}

      <div className="rounded-lg border border-accent/30 bg-accent-soft p-3">
        <div className="mb-2 text-[11px] font-semibold tracking-wide text-accent">POSITION SIZING (real lenses — no Kelly, see lib/guru-lens.ts)</div>
        <div className="grid grid-cols-2 gap-y-1.5 font-mono text-[12px]">
          <span className="text-foreground-soft">Turtle unit (1%/N)</span>
          <span className="text-right text-foreground">{candidate.turtleWeightPct != null ? `${candidate.turtleWeightPct.toFixed(1)}% port` : "— (ต้อง breakout ก่อน)"}</span>
          <span className="text-foreground-soft">Exit level</span>
          <span className="text-right text-nogo">{candidate.turtleExitLow != null ? candidate.turtleExitLow.toFixed(2) : "—"}</span>
        </div>
        <Link href={`/stock/${candidate.ticker}`} className="mt-2 inline-block text-[11px] text-accent hover:underline">
          ดู inverse-vol Position Sizing + full report →
        </Link>
      </div>
    </div>
  );
}

export function GuruLensApp({ candidates, lensMeta }: { candidates: DisplayCandidate[]; lensMeta: LensMeta[] }) {
  const [tab, setTab] = useState("overview");
  const [stockTicker, setStockTicker] = useState<string | null>(null);
  const pick = (t: string) => {
    setStockTicker(t);
    setTab("stock");
  };
  const selected = stockTicker ? candidates.find((c) => c.ticker === stockTicker) : null;

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">
          Guru Lens <span className="font-mono text-sm font-normal text-foreground-faint">{candidates.length} หุ้นใน universe</span>
        </h1>
      </div>
      <p className="mb-5 text-sm text-foreground-soft">9 investor persona ประเมินหุ้นเดียวกันด้วยกฎ deterministic ของแต่ละคน จากข้อมูลจริงในระบบ — ไม่มี LLM เรียกในหน้านี้</p>

      <nav className="mb-5 flex flex-wrap gap-1.5">
        {[
          ["overview", "Overview"],
          ["lens", "Guru Lens"],
          ["signals", "Turtle Signals"],
          ...(selected ? [["stock", selected.ticker]] : []),
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors ${tab === k ? "border-accent/60 bg-accent-soft text-accent" : "border-card-border text-foreground-faint hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "overview" && <Overview candidates={candidates} onPick={pick} />}
      {tab === "lens" && <LensView candidates={candidates} lensMeta={lensMeta} />}
      {tab === "signals" && <Signals candidates={candidates} />}
      {tab === "stock" && selected && <StockDetail candidate={selected} lensMeta={lensMeta} onBack={() => setTab("overview")} />}
    </main>
  );
}
