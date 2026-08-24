import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth/session";
import { CardHeading } from "@/components/ui/Card";
import { StampBadge, Badge } from "@/components/ui/Badge";
import type { Market } from "../generated/prisma/client";
import type { StockReport } from "@/lib/report/types";
import { isRegret } from "@/lib/verdict-stats";

const MARKETS: Market[] = ["TH", "US", "HK"];

const REGIME_VARIANT: Record<string, "go" | "wait" | "no_go"> = {
  RISK_ON: "go",
  MIXED: "wait",
  RISK_OFF: "no_go",
};

const GATE_ORDER = [1, 2, 3, 4, 5, 6, 7];
const RECENT_VERDICTS_LIMIT = 6;
const RECENT_FACTS_LIMIT = 6;

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return "<1h";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default async function Home() {
  const user = await getSessionUser();

  const [allReports, regimes, latestRefresh, watchlistCount] = await Promise.all([
    // Same "order by ticker, then recency, keep first-per-ticker" dedupe pattern used throughout
    // scripts/{position-sizing,thesis-momentum,read-across}.ts -- dataAsOf is a date not a
    // timestamp, so createdAt breaks same-day-rerun ties.
    prisma.researchReport.findMany({
      orderBy: [{ ticker: "asc" }, { dataAsOf: "desc" }, { createdAt: "desc" }],
      select: { id: true, ticker: true, decision: true, conviction: true, dataAsOf: true, payload: true },
    }),
    Promise.all(
      MARKETS.map((market) =>
        prisma.marketRegime.findFirst({ where: { market }, orderBy: { date: "desc" }, select: { market: true, classification: true, breadthPct: true } }),
      ),
    ),
    prisma.refreshLog.findFirst({ orderBy: { startedAt: "desc" } }),
    user ? prisma.watchlistItem.count({ where: { userId: user.id } }) : Promise.resolve(0),
  ]);

  const latestByTicker = new Map<string, (typeof allReports)[number]>();
  for (const r of allReports) if (!latestByTicker.has(r.ticker)) latestByTicker.set(r.ticker, r);
  const latestReports = [...latestByTicker.values()];
  const recentVerdicts = latestReports.sort((a, b) => b.dataAsOf.getTime() - a.dataAsOf.getTime()).slice(0, RECENT_VERDICTS_LIMIT);

  const waitCount = latestReports.filter((r) => r.decision === "WAIT").length;

  // Sector tags for the verdict feed -- one query for every ticker currently shown, not per-row.
  const sectorByTicker = new Map(
    (await prisma.stock.findMany({ where: { ticker: { in: recentVerdicts.map((r) => r.ticker) } }, select: { ticker: true, sector: true } })).map(
      (s) => [s.ticker, s.sector] as const,
    ),
  );

  // Gate dots per verdict row -- real QualityGateLog rows for exactly these reports, not fabricated.
  // One batched query (reportId IN [...]), not one query per row -- N sequential round-trips is
  // exactly the query volume that tripped the local prisma dev connection instability found earlier
  // this session (scripts/backfill-price-ohlc.ts's doc comment); this page runs on every home-page
  // load, so it's worth avoiding here even more than in a one-off script.
  const allGateLogs = await prisma.qualityGateLog.findMany({
    where: { reportId: { in: recentVerdicts.map((r) => r.id) } },
    select: { reportId: true, gateNumber: true, passed: true },
  });
  const gateLogsByReport = new Map<string, boolean[]>();
  for (const r of recentVerdicts) {
    const byGate = new Map(allGateLogs.filter((l) => l.reportId === r.id).map((l) => [l.gateNumber, l.passed]));
    gateLogsByReport.set(
      r.id,
      GATE_ORDER.filter((g) => byGate.has(g)).map((g) => byGate.get(g)!),
    );
  }

  // Pipeline status strip -- gate pass/fail aggregated across the same recent-verdicts window (this
  // app's two pipelines -- Snowflake refresh (RefreshLog) and Compound OS analysis (QualityGateLog)
  // -- run independently, so "gates" here is intentionally scoped to Compound OS reports, not tied
  // to the nightly RefreshLog above it.
  const allGateOutcomes = [...gateLogsByReport.values()].flat();
  const gatesPassed = allGateOutcomes.filter(Boolean).length;
  const gatesFailed = allGateOutcomes.length - gatesPassed;

  // Facts changed feed -- most recently ingested FinancialFact rows, deduped to one per
  // (ticker, metricName) so one ingest run doesn't crowd the feed with near-duplicates. Shows a
  // real delta against the prior value for that exact (ticker, metricName) pair when one exists
  // (e.g. an analyst estimate revision) -- "new" (not a fabricated 0) when it doesn't. Two batched
  // queries total (not one query per row -- see the gate-logs comment above for why that matters).
  const recentFactsRaw = await prisma.financialFact.findMany({
    orderBy: { extractedAt: "desc" },
    take: 30,
    select: { ticker: true, metricName: true, value: true, unit: true, extractedAt: true },
  });
  const seenMetric = new Set<string>();
  const topFacts: typeof recentFactsRaw = [];
  for (const f of recentFactsRaw) {
    const key = `${f.ticker}:${f.metricName}`;
    if (seenMetric.has(key)) continue;
    seenMetric.add(key);
    topFacts.push(f);
    if (topFacts.length >= RECENT_FACTS_LIMIT) break;
  }
  const priorCandidates = topFacts.length
    ? await prisma.financialFact.findMany({
        where: { OR: topFacts.map((f) => ({ ticker: f.ticker, metricName: f.metricName, extractedAt: { lt: f.extractedAt } })) },
        orderBy: { extractedAt: "desc" },
        select: { ticker: true, metricName: true, value: true, extractedAt: true },
      })
    : [];
  const recentFacts = topFacts.map((f) => {
    const prior = priorCandidates.find((p) => p.ticker === f.ticker && p.metricName === f.metricName);
    return { ...f, priorValue: prior && prior.value !== f.value ? prior.value : null };
  });

  // Scorecard mini -- verdict count + decision mix (real, cheap) + WAIT regret (needs a price
  // comparison per WAIT, same lib/verdict-stats.ts logic scripts/scorecard.ts uses).
  const decisionCounts = { GO: 0, WAIT: 0, NO_GO: 0 } as Record<string, number>;
  for (const r of latestReports) decisionCounts[r.decision] = (decisionCounts[r.decision] ?? 0) + 1;

  const waitReports = latestReports.filter((r) => r.decision === "WAIT");
  // Batched stock lookup (one query, not one per WAIT); priceHistory still needs a per-ticker
  // "closest date <= this WAIT's own dataAsOf" query since each WAIT has a different cutoff date --
  // bounded by however many WAITs exist (typically small), not by the full universe.
  const waitStocksByTicker = new Map(
    (await prisma.stock.findMany({ where: { ticker: { in: waitReports.map((r) => r.ticker) } }, select: { ticker: true, id: true, price: true } })).map(
      (s) => [s.ticker, s] as const,
    ),
  );
  let regretCount = 0;
  for (const r of waitReports) {
    const stock = waitStocksByTicker.get(r.ticker);
    if (!stock?.id || stock.price == null) continue;
    const priceAtVerdict = await prisma.priceHistory.findFirst({
      where: { stockId: stock.id, date: { lte: r.dataAsOf } },
      orderBy: { date: "desc" },
      select: { close: true },
    });
    if (priceAtVerdict?.close == null) continue;
    const returnPct = ((stock.price - priceAtVerdict.close) / priceAtVerdict.close) * 100;
    if (isRegret(r.decision, returnPct)) regretCount++;
  }

  // Themes -- Stock.themes is manually set (no Theme Agent yet), so this is real but currently
  // sparse; shows whatever's actually there rather than padding it out.
  const themedStocks = await prisma.stock.findMany({ where: { themes: { isEmpty: false } }, select: { ticker: true, name: true, sector: true, themes: true } });
  const themeMap = new Map<string, { ticker: string; name: string; sector: string | null }[]>();
  for (const s of themedStocks) {
    for (const theme of s.themes) {
      const list = themeMap.get(theme) ?? [];
      list.push({ ticker: s.ticker, name: s.name, sector: s.sector });
      themeMap.set(theme, list);
    }
  }

  return (
    <>
      {/* Pipeline status strip -- real RefreshLog (Snowflake refresh) + QualityGateLog (Compound OS
          reports) + watchlist + AGENT_PROVIDER, not one unified job: this app runs those two
          pipelines independently, see the comment above gatesPassed/gatesFailed. */}
      <div className="border-b border-card-border bg-foreground font-mono text-[12.5px] text-background/90">
        <div className="mx-auto flex max-w-6xl gap-0 overflow-x-auto px-6">
          <div className="shrink-0 whitespace-nowrap border-r border-background/15 px-4 py-2.5">
            <span className="block text-[10.5px] uppercase tracking-wide text-background/50">Last Refresh</span>
            <span className="font-semibold">{latestRefresh ? `${latestRefresh.startedAt.toLocaleDateString("en-US")} ${latestRefresh.startedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : "never"}</span>
          </div>
          <div className="shrink-0 whitespace-nowrap border-r border-background/15 px-4 py-2.5">
            <span className="block text-[10.5px] uppercase tracking-wide text-background/50">Tickers</span>
            <span className="font-semibold">
              {latestRefresh ? `${latestRefresh.tickersProcessed - latestRefresh.tickersFailed}/${latestRefresh.tickersProcessed}` : "—"}{" "}
              <span className={latestRefresh?.status === "SUCCESS" ? "text-go" : "text-wait"}>{latestRefresh?.status.toLowerCase() ?? ""}</span>
            </span>
          </div>
          <div className="shrink-0 whitespace-nowrap border-r border-background/15 px-4 py-2.5">
            <span className="block text-[10.5px] uppercase tracking-wide text-background/50">Runtime</span>
            <span className="font-semibold">
              {latestRefresh?.finishedAt ? `${Math.round((latestRefresh.finishedAt.getTime() - latestRefresh.startedAt.getTime()) / 1000 / 60)}m` : "—"}
            </span>
          </div>
          <div className="shrink-0 whitespace-nowrap border-r border-background/15 px-4 py-2.5">
            <span className="block text-[10.5px] uppercase tracking-wide text-background/50">Compound OS Gates</span>
            <span className="font-semibold">
              <span className="text-go">{gatesPassed} pass</span>
              {gatesFailed > 0 && <> · <span className="text-nogo">{gatesFailed} fail</span></>}
            </span>
          </div>
          <div className="shrink-0 whitespace-nowrap border-r border-background/15 px-4 py-2.5">
            <span className="block text-[10.5px] uppercase tracking-wide text-background/50">Watchlist</span>
            <span className="font-semibold">
              {watchlistCount} {waitCount > 0 && <span className="text-wait">· {waitCount} WAIT</span>}
            </span>
          </div>
          <div className="shrink-0 whitespace-nowrap px-4 py-2.5">
            <span className="block text-[10.5px] uppercase tracking-wide text-background/50">Provider</span>
            <span className="font-semibold">{process.env.AGENT_PROVIDER ?? "claude-cli"}</span>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
          {/* Verdicts feed */}
          {/* min-w-0: a grid item defaults to min-width:auto, so the truncated thesis text below
              (which needs a constrained width to truncate at all) would otherwise force this
              track -- and the whole grid -- to expand to the untruncated text's intrinsic width
              instead of respecting the 1.15fr/0.85fr split. Confirmed live: without this the right
              column rendered ~8000px off-screen. */}
          <section className="min-w-0 rounded-xl border border-card-border bg-card">
            <div className="flex items-baseline justify-between border-b border-card-border px-4 py-3">
              <CardHeading className="text-foreground-soft">Verdicts ล่าสุด</CardHeading>
              <Link href="/screener" className="text-xs font-semibold text-accent">รายงานทั้งหมด »</Link>
            </div>
            {recentVerdicts.length === 0 ? (
              <p className="px-4 py-6 text-sm text-foreground-faint">
                ยังไม่มี Compound OS report — เปิดหน้าหุ้นที่สนใจแล้วกด &quot;Analyze this stock&quot;
              </p>
            ) : (
              recentVerdicts.map((r) => {
                const report = r.payload as unknown as StockReport;
                const sector = sectorByTicker.get(r.ticker);
                const gates = gateLogsByReport.get(r.id) ?? [];
                return (
                  <Link key={r.ticker} href={`/stock/${r.ticker}`} className="flex gap-3 border-b border-card-border px-4 py-3 last:border-0 hover:bg-foreground/[0.02]">
                    <StampBadge text={r.decision === "NO_GO" ? "NO-GO" : r.decision} variant={r.decision === "NO_GO" ? "no_go" : (r.decision.toLowerCase() as "go" | "wait")} />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm font-semibold">
                        {r.ticker} {sector && <span className="ml-1.5 font-sans text-xs font-normal text-foreground-faint">{sector}</span>}
                      </div>
                      <p className="mt-0.5 truncate text-[13.5px] text-foreground-soft">{report.verdict?.thesis}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[11px] text-foreground-faint">
                        <span>conviction {r.conviction}/5</span>
                        {gates.length > 0 && (
                          <span className="tracking-widest">
                            G {gates.map((p, i) => <span key={i} className={p ? "text-go" : "text-nogo"}>●</span>)}
                          </span>
                        )}
                        <span>{r.dataAsOf.toLocaleDateString("en-US")}</span>
                      </div>
                    </div>
                  </Link>
                );
              })
            )}
          </section>

          <div className="flex min-w-0 flex-col gap-5">
            {/* Facts changed */}
            <section className="rounded-xl border border-card-border bg-card">
              <div className="flex items-baseline justify-between border-b border-card-border px-4 py-3">
                <CardHeading className="text-foreground-soft">Facts เปลี่ยนแปลง</CardHeading>
              </div>
              {recentFacts.length === 0 ? (
                <p className="px-4 py-4 text-sm text-foreground-faint">ยังไม่มีข้อมูล</p>
              ) : (
                recentFacts.map((f, i) => (
                  <div key={`${f.ticker}-${f.metricName}`} className="flex gap-3 border-b border-card-border px-4 py-2.5 text-[13.5px] last:border-0">
                    <span className="font-mono text-xs text-foreground-faint">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <span className="font-mono font-semibold text-accent">{f.ticker}</span>{" "}
                      <span className="text-foreground-soft">{f.metricName}</span>{" "}
                      {f.priorValue != null ? (
                        <span className={`font-mono font-semibold ${f.value >= f.priorValue ? "text-go" : "text-nogo"}`}>
                          {f.value >= f.priorValue ? "▲" : "▼"} {f.priorValue.toLocaleString()} → {f.value.toLocaleString()}
                        </span>
                      ) : (
                        <span className="font-mono text-foreground-faint">{f.value.toLocaleString()} (ใหม่)</span>
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-foreground-faint">{timeAgo(f.extractedAt)}</span>
                  </div>
                ))
              )}
            </section>

            {/* Scorecard mini */}
            <section className="rounded-xl border border-card-border bg-card">
              <div className="flex items-baseline justify-between border-b border-card-border px-4 py-3">
                <CardHeading className="text-foreground-soft">Scorecard</CardHeading>
                <span className="text-xs text-foreground-faint font-mono">npx tsx scripts/scorecard.ts</span>
              </div>
              <div className="grid grid-cols-3 divide-x divide-card-border text-center">
                <div className="px-2 py-4">
                  <div className="font-mono text-xl font-semibold">{latestReports.length}</div>
                  <div className="mt-0.5 text-[11px] text-foreground-faint">Verdicts logged</div>
                </div>
                <div className="px-2 py-4">
                  <div className="font-mono text-xl font-semibold text-go">{decisionCounts.GO}</div>
                  <div className="mt-0.5 text-[11px] text-foreground-faint">GO</div>
                </div>
                <div className="px-2 py-4">
                  <div className="font-mono text-xl font-semibold text-wait">{decisionCounts.WAIT}</div>
                  <div className="mt-0.5 text-[11px] text-foreground-faint">WAIT</div>
                </div>
              </div>
              {regretCount > 0 && (
                <div className="border-t border-card-border bg-wait-bg px-4 py-2.5 text-[12.5px] text-wait">
                  ⚠ {regretCount} WAIT verdict{regretCount === 1 ? "" : "s"} flagged as regret — ราคาวิ่งเกิน 15% โดยไม่มีใคร re-review
                </div>
              )}
            </section>

            {/* Market regime */}
            <section className="rounded-xl border border-card-border bg-card p-4">
              <CardHeading className="text-foreground-soft">Market Regime</CardHeading>
              <div className="mt-2 flex flex-wrap gap-2">
                {regimes.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => (
                  <Badge key={r.market} text={`${r.market} ${r.classification}`} variant={REGIME_VARIANT[r.classification] ?? "neutral"} />
                ))}
                {regimes.every((r) => r === null) && <span className="text-xs text-foreground-faint">not computed yet</span>}
              </div>
            </section>
          </div>
        </div>

        {/* Themes */}
        <section className="mt-5 rounded-xl border border-card-border bg-card">
          <div className="flex items-baseline justify-between border-b border-card-border px-4 py-3">
            <CardHeading className="text-foreground-soft">Themes</CardHeading>
          </div>
          {themeMap.size === 0 ? (
            <p className="px-4 py-4 text-sm text-foreground-faint">
              ยังไม่มีหุ้นตั้ง theme — <code className="rounded bg-foreground/5 px-1">Stock.themes</code> ตั้งเองผ่าน{" "}
              <code className="rounded bg-foreground/5 px-1">scripts/theme-pipeline.ts</code>
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-card-border text-left text-[11px] uppercase tracking-wide text-foreground-faint">
                  <th className="px-4 py-2.5 font-medium">Theme</th>
                  <th className="px-4 py-2.5 font-medium">Tickers</th>
                </tr>
              </thead>
              <tbody>
                {[...themeMap.entries()].map(([theme, members]) => (
                  <tr key={theme} className="border-b border-card-border last:border-0 hover:bg-foreground/[0.02]">
                    <td className="px-4 py-3 font-medium">{theme}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {members.map((m) => (
                          <Link key={m.ticker} href={`/stock/${m.ticker}`} className="font-mono text-accent hover:underline">
                            {m.ticker}
                          </Link>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </>
  );
}
