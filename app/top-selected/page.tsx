import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { CardHeading } from "@/components/ui/Card";
import { StampBadge } from "@/components/ui/Badge";
import { AnalyzeButton } from "@/components/AnalyzeButton";
import { readAnalyzeStatus } from "@/lib/analyze-status";
import type { Market } from "../../generated/prisma/client";
import type { StockReport, MoatItem } from "@/lib/report/types";

const MARKETS: Market[] = ["TH", "US", "HK"];
const GATE_ORDER = [1, 2, 3, 4, 5, 6, 7];
const DEFAULT_LIMIT = 25;

type Grade = "A" | "B" | "C" | "D" | "—";

// Snowflake dimension scores are 0-5 (see lib/scoring.ts's percentile/20), not the mockup's
// original 0-10 scale -- thresholds rebased to match the real data instead of forcing a fictional
// scale onto it.
function gradeFromScore(score: number | null | undefined): Grade {
  if (score == null) return "—";
  if (score >= 4) return "A";
  if (score >= 3) return "B";
  if (score >= 2) return "C";
  return "D";
}

const GRADE_STYLE: Record<Grade, string> = {
  A: "text-grade-a bg-grade-a-bg",
  B: "text-grade-b bg-grade-b-bg",
  C: "text-wait bg-wait-bg",
  D: "text-nogo bg-nogo-bg",
  "—": "text-foreground-faint bg-foreground/5",
};

function GradeChip({ grade }: { grade: Grade }) {
  return <span className={`inline-block min-w-8 rounded px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold ${GRADE_STYLE[grade]}`}>{grade}</span>;
}

const MOAT_STRENGTH_RANK: Record<MoatItem["strength"], number> = { strong: 3, moderate: 2, weak: 1 };

// Best real moat item on the report (excluding an explicit "no moat found" entry) -> A/B/C.
// No report at all -> "—" (unknown, not yet analyzed), which is a different fact than "D" (analyzed,
// no moat found).
function moatGrade(moat: MoatItem[] | undefined): Grade {
  if (!moat) return "—";
  const real = moat.filter((m) => m.type !== "none");
  if (real.length === 0) return "D";
  const best = real.reduce((a, b) => (MOAT_STRENGTH_RANK[b.strength] > MOAT_STRENGTH_RANK[a.strength] ? b : a));
  if (best.strength === "strong") return "A";
  if (best.strength === "moderate") return "B";
  return "C";
}

function fmtPrice(v: number | null, currency: string | null): string {
  if (v == null) return "—";
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency ?? ""}`.trim();
}

export default async function TopSelectedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const s = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const market = s("market") as Market | "";
  const sector = s("sector");
  const minComposite = s("minComposite") ? Number(s("minComposite")) : null;
  const limit = s("limit") ? Math.min(Math.max(Number(s("limit")), 1), 100) : DEFAULT_LIMIT;

  const [stocks, sectors] = await Promise.all([
    prisma.stock.findMany({
      where: {
        isActive: true,
        latestOverallScore: { not: null, ...(minComposite != null && { gte: minComposite * 10 }) },
        ...(market && { market }),
        ...(sector && { sector }),
      },
      orderBy: { latestOverallScore: "desc" },
      take: limit,
      select: {
        ticker: true,
        name: true,
        sector: true,
        market: true,
        price: true,
        currency: true,
        priceChangePct1d: true,
        latestOverallScore: true,
        latestValueScore: true,
        latestFutureScore: true,
        latestHealthScore: true,
        latestMomentumScore: true,
      },
    }),
    prisma.stock.findMany({ where: { isActive: true, sector: { not: null } }, select: { sector: true }, distinct: ["sector"], orderBy: { sector: "asc" } }),
  ]);

  // Latest ResearchReport per ticker -- same dedupe (first per ticker, already ordered by recency)
  // and same batched-gate-log pattern as app/page.tsx, so this table never issues one query per row.
  const reports = await prisma.researchReport.findMany({
    where: { ticker: { in: stocks.map((s) => s.ticker) } },
    orderBy: [{ ticker: "asc" }, { dataAsOf: "desc" }, { createdAt: "desc" }],
    select: { id: true, ticker: true, decision: true, payload: true },
  });
  const reportByTicker = new Map<string, (typeof reports)[number]>();
  for (const r of reports) if (!reportByTicker.has(r.ticker)) reportByTicker.set(r.ticker, r);

  const gateLogs = await prisma.qualityGateLog.findMany({
    where: { reportId: { in: [...reportByTicker.values()].map((r) => r.id) } },
    select: { reportId: true, gateNumber: true, passed: true },
  });
  const gatesByReport = new Map<string, boolean[]>();
  for (const r of reportByTicker.values()) {
    const byGate = new Map(gateLogs.filter((l) => l.reportId === r.id).map((l) => [l.gateNumber, l.passed]));
    gatesByReport.set(r.id, GATE_ORDER.filter((g) => byGate.has(g)).map((g) => byGate.get(g)!));
  }

  const sectorOptions = sectors.map((s) => s.sector).filter((v): v is string => v != null);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="text-2xl font-bold">Top Selected</h1>
      <p className="mt-1 max-w-2xl text-sm text-foreground-soft">
        จัดอันดับหุ้นทั้งหมดที่มี Snowflake score จริง (latestOverallScore) — เกรดแต่ละคอลัมน์มาจากคะแนนจริงของแต่ละมิติ ไม่ใช่ analyst ภายนอก
        Composite = latestOverallScore/10
      </p>

      <form method="get" className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-card-border bg-card p-4">
        <label className="flex flex-col gap-1 text-xs text-foreground-faint">
          Market
          <select name="market" defaultValue={market} className="rounded-md border border-card-border bg-background px-2 py-1.5 text-sm text-foreground">
            <option value="">All</option>
            {MARKETS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-faint">
          Sector
          <select name="sector" defaultValue={sector} className="rounded-md border border-card-border bg-background px-2 py-1.5 text-sm text-foreground">
            <option value="">All</option>
            {sectorOptions.map((sec) => (
              <option key={sec} value={sec}>{sec}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-faint">
          Composite ≥ <span className="text-foreground-faint/70">(0-10)</span>
          <input type="number" step="0.1" min="0" max="10" name="minComposite" defaultValue={s("minComposite")} className="w-24 rounded-md border border-card-border bg-background px-2 py-1.5 text-sm text-foreground" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-faint">
          Limit
          <input type="number" min="1" max="100" name="limit" defaultValue={s("limit") || String(DEFAULT_LIMIT)} className="w-20 rounded-md border border-card-border bg-background px-2 py-1.5 text-sm text-foreground" />
        </label>
        <button type="submit" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90">Filter</button>
        <Link href="/top-selected" className="text-sm text-foreground-faint hover:text-foreground">Reset</Link>
      </form>

      <div className="mt-5 overflow-hidden rounded-xl border border-card-border bg-card">
        <div className="flex items-center justify-between border-b border-card-border px-4 py-3">
          <CardHeading>ผลการคัด: {stocks.length}</CardHeading>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b border-card-border text-center text-[10.5px] uppercase tracking-wide text-foreground-faint">
                <th className="px-2.5 py-2.5 text-left font-medium">Rank</th>
                <th className="px-2.5 py-2.5 text-left font-medium">Symbol</th>
                <th className="px-2.5 py-2.5 font-medium">Price</th>
                <th className="px-2.5 py-2.5 font-medium">Chg %</th>
                <th className="px-2.5 py-2.5 font-medium">Composite</th>
                <th className="px-2.5 py-2.5 font-medium">Valuation</th>
                <th className="px-2.5 py-2.5 font-medium">Growth</th>
                <th className="px-2.5 py-2.5 font-medium">Moat</th>
                <th className="px-2.5 py-2.5 font-medium">Risk</th>
                <th className="px-2.5 py-2.5 font-medium">Momentum</th>
                <th className="px-2.5 py-2.5 font-medium">Sentiment</th>
                <th className="px-2.5 py-2.5 font-medium">Gates</th>
                <th className="px-2.5 py-2.5 font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {stocks.map((stock, i) => {
                const report = reportByTicker.get(stock.ticker);
                const payload = report?.payload as unknown as StockReport | undefined;
                const gates = report ? gatesByReport.get(report.id) ?? [] : [];
                const chg = stock.priceChangePct1d;
                return (
                  <tr key={stock.ticker} className="border-b border-card-border text-center last:border-0 hover:bg-foreground/[0.02]">
                    <td className="px-2.5 py-2.5 text-left font-mono text-xs text-foreground-faint">{i + 1}</td>
                    <td className="px-2.5 py-2.5 text-left">
                      <Link href={`/stock/${stock.ticker}`} className="font-mono font-semibold text-accent hover:underline">{stock.ticker}</Link>
                      <div className="text-xs text-foreground-soft">
                        {stock.name} {stock.sector && <span className="text-foreground-faint">· {stock.sector}</span>}
                      </div>
                    </td>
                    <td className="px-2.5 py-2.5 font-mono">{fmtPrice(stock.price, stock.currency)}</td>
                    <td className={`px-2.5 py-2.5 font-mono text-xs ${chg == null ? "text-foreground-faint" : chg >= 0 ? "text-go" : "text-nogo"}`}>
                      {chg == null ? "—" : `${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%`}
                    </td>
                    <td className="px-2.5 py-2.5">
                      <span className="inline-block min-w-12 rounded-md bg-foreground px-2 py-1 font-mono text-sm font-semibold text-background">
                        {stock.latestOverallScore != null ? (stock.latestOverallScore / 10).toFixed(1) : "—"}
                      </span>
                    </td>
                    <td className="px-2.5 py-2.5"><GradeChip grade={gradeFromScore(stock.latestValueScore)} /></td>
                    <td className="px-2.5 py-2.5"><GradeChip grade={gradeFromScore(stock.latestFutureScore)} /></td>
                    <td className="px-2.5 py-2.5"><GradeChip grade={moatGrade(payload?.moat)} /></td>
                    <td className="px-2.5 py-2.5"><GradeChip grade={gradeFromScore(stock.latestHealthScore)} /></td>
                    <td className="px-2.5 py-2.5"><GradeChip grade={gradeFromScore(stock.latestMomentumScore)} /></td>
                    <td className="px-2.5 py-2.5 font-mono text-xs text-foreground-faint">—</td>
                    <td className="px-2.5 py-2.5">
                      {gates.length > 0 ? (
                        <span className="font-mono text-xs tracking-widest">
                          {gates.map((p, gi) => <span key={gi} className={p ? "text-go" : "text-nogo"}>●</span>)}
                        </span>
                      ) : (
                        <span className="text-xs text-foreground-faint">—</span>
                      )}
                    </td>
                    <td className="px-2.5 py-2.5">
                      {report ? (
                        <StampBadge text={report.decision === "NO_GO" ? "NO-GO" : report.decision} variant={report.decision === "NO_GO" ? "no_go" : (report.decision.toLowerCase() as "go" | "wait")} />
                      ) : (
                        <AnalyzeButton ticker={stock.ticker} hasReport={false} initialStatus={readAnalyzeStatus(stock.ticker)} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {stocks.length === 0 && <p className="px-4 py-8 text-center text-sm text-foreground-faint">ไม่มีหุ้นที่ตรงเงื่อนไข</p>}

        <div className="flex flex-wrap gap-4 border-t border-card-border px-4 py-3 font-mono text-[11px] text-foreground-faint">
          <span>เกรด: A ≥4.0 · B 3.0-4.0 · C 2.0-3.0 · D &lt;2.0 (สเกลจริง 0-5 ต่อมิติ)</span>
          <span>Gates ●=G1-G7 จริงจาก QualityGateLog</span>
          <span>Sentiment &quot;—&quot; = รอ Xueqiu Layer 8 (Phase 3, ยังไม่ implement)</span>
          <span>Moat &quot;—&quot; = ยังไม่มี Compound OS report · D = วิเคราะห์แล้วไม่พบ moat</span>
          <span>Risk: เกรดมาจาก latestHealthScore ตรงๆ (A = แข็งแกร่งทางการเงินสูง = เสี่ยงต่ำ)</span>
        </div>
      </div>
    </main>
  );
}
