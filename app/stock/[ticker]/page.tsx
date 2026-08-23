import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth/session";
import { WatchlistButton } from "@/components/WatchlistButton";
import { SnowflakeChart } from "@/components/SnowflakeChart";
import { DeepReportPanel } from "@/components/DeepReportPanel";
import type { RawMetrics, DimensionDetail } from "@/lib/scoring";
import type { StockReport, TriggerComparator } from "@/lib/report/types";
import { computeAnnualizedVolatility, suggestPositionSize } from "@/lib/position-sizing";

function fmtNum(v: number | null | undefined, opts?: Intl.NumberFormatOptions): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("en-US", opts).format(v);
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

function fmtMoney(v: number | null | undefined, currency: string | null | undefined): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency ?? "USD",
    maximumFractionDigits: 2,
  }).format(v);
}

function fmtCompact(v: number | null | undefined): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 dark:border-white/15 p-4">
      <div className="text-xs uppercase tracking-wide text-black/50 dark:text-white/50">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function isLimitedData(d: DimensionDetail | undefined): boolean {
  if (!d) return true;
  return d.availableCount < Math.ceil(d.totalCount / 2);
}

function DimensionLabel({ label, detail }: { label: string; detail: DimensionDetail | undefined }) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      {isLimitedData(detail) && (
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
          Limited data
        </span>
      )}
    </span>
  );
}

const DECISION_STYLE: Record<string, string> = {
  GO: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  WAIT: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  NO_GO: "bg-red-500/15 text-red-700 dark:text-red-400",
};

const GATE_STATUS_STYLE: Record<string, string> = {
  APPROVED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  REJECTED: "bg-red-500/15 text-red-700 dark:text-red-400",
  PENDING: "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60",
};

function Badge({ text, styleKey, styles }: { text: string; styleKey: string; styles: Record<string, string> }) {
  const cls = styles[styleKey] ?? "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60";
  return <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${cls}`}>{text}</span>;
}

const COMPARATOR_SYMBOL: Record<TriggerComparator, string> = { lt: "<", lte: "≤", gt: ">", gte: "≥" };

function TriggerTable({ triggers }: { triggers: StockReport["verdict"]["invalidationTriggers"] }) {
  if (!triggers.length) return <p className="text-sm text-black/50 dark:text-white/50">none</p>;
  return (
    <ul className="mt-2 space-y-1.5 text-sm">
      {triggers.map((t, i) => (
        <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-black/80 dark:text-white/80">{t.description}</span>
          <span className="whitespace-nowrap font-mono text-xs text-black/50 dark:text-white/50">
            {t.metricName} {COMPARATOR_SYMBOL[t.comparator]} {t.threshold.toLocaleString("en-US")}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function StockPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker: rawTicker } = await params;
  const ticker = decodeURIComponent(rawTicker).toUpperCase();

  const stock = await prisma.stock.findUnique({
    where: { ticker },
    include: {
      financialHistory: {
        orderBy: { fiscalDateEnding: "asc" },
      },
      scoreSnapshots: {
        orderBy: { date: "desc" },
        take: 1,
      },
    },
  });

  if (!stock) notFound();

  const rawMetrics = stock.scoreSnapshots[0]?.rawMetricsJson as unknown as RawMetrics | undefined;
  const dims = rawMetrics?.dimensions;

  const annualHistory = stock.financialHistory.filter((h) => h.periodType === "ANNUAL");
  // Last 8 quarters (2 years) is plenty for a trend table — older quarterly rows just clutter it.
  const quarterlyHistory = stock.financialHistory.filter((h) => h.periodType === "QUARTERLY").slice(-8);

  const staleDays = stock.lastFetchedAt
    ? Math.floor((Date.now() - stock.lastFetchedAt.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const user = await getSessionUser();
  const watchlistItem = user
    ? await prisma.watchlistItem.findUnique({
        where: { userId_stockId: { userId: user.id, stockId: stock.id } },
        select: { id: true },
      })
    : null;
  const deepReport = user
    ? await prisma.deepReport.findFirst({
        where: { stockId: stock.id, userId: user.id },
        orderBy: { createdAt: "desc" },
        select: { content: true, model: true, createdAt: true },
      })
    : null;

  // dataAsOf is a date, not a timestamp -- createdAt breaks same-day-rerun ties in favor of the
  // actually-most-recent run (same reasoning as scripts/position-sizing.ts's identical query).
  const researchReportRow = await prisma.researchReport.findFirst({
    where: { ticker: stock.ticker },
    orderBy: [{ dataAsOf: "desc" }, { createdAt: "desc" }],
    select: { payload: true, decision: true, conviction: true, gateStatus: true, dataAsOf: true, obsidianPath: true },
  });
  const researchReport = researchReportRow ? (researchReportRow.payload as unknown as StockReport) : null;

  // Position Sizing Model (Phase 5) -- only meaningful for a *current* GO, same "not sizeable" rule
  // as scripts/position-sizing.ts. PriceHistory is weekly, not daily -- see lib/position-sizing.ts's
  // computeAnnualizedVolatility doc comment for why that changes the annualization math.
  const positionSize = researchReportRow?.decision === "GO"
    ? await (async () => {
        const priceRows = await prisma.priceHistory.findMany({
          where: { stockId: stock.id },
          orderBy: { date: "desc" },
          take: 52,
          select: { close: true },
        });
        const closes = priceRows.map((p) => p.close).reverse();
        const vol = computeAnnualizedVolatility(closes);
        return suggestPositionSize(researchReportRow.conviction, vol);
      })()
    : null;

  // Sector Concentration context (Phase 5 extension) -- how many of the signed-in user's *other*
  // watchlist tickers already share this stock's sector, shown alongside a position-size suggestion
  // as context, not a math adjustment to the suggested weight itself: there's no validated study
  // behind any specific size discount for sector concentration, so inventing one would be the same
  // fabricated-precision mistake lib/position-sizing.ts's doc comment already rejects for Kelly.
  const sameSectorWatchlistCount = positionSize && user && stock.sector
    ? await prisma.watchlistItem.count({
        where: { userId: user.id, stockId: { not: stock.id }, stock: { sector: stock.sector } },
      })
    : 0;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <div className="text-sm text-black/50 dark:text-white/50">
            {stock.ticker} · {stock.exchange} · {stock.market}
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{stock.name}</h1>
            <WatchlistButton ticker={stock.ticker} watchlistItemId={watchlistItem?.id} />
          </div>
          {stock.sector && (
            <div className="mt-1 text-sm text-black/50 dark:text-white/50">
              {stock.sector}
              {stock.industry ? ` · ${stock.industry}` : ""}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold tabular-nums">{fmtMoney(stock.price, stock.currency)}</div>
          {stock.priceChangePct1d != null && (
            <div
              className={`text-sm tabular-nums ${
                stock.priceChangePct1d >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
              }`}
            >
              {stock.priceChangePct1d >= 0 ? "+" : ""}
              {fmtPct(stock.priceChangePct1d)}
            </div>
          )}
        </div>
      </div>

      {staleDays != null && staleDays > 2 && (
        <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          Data as of {stock.lastFetchedAt?.toLocaleDateString("en-US")} ({staleDays} days ago)
        </div>
      )}

      {researchReportRow && researchReport && (
        <section className="mt-8 rounded-lg border border-black/10 p-4 dark:border-white/15">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
              Research Verdict
            </h2>
            <div className="flex items-center gap-2">
              <Badge text={researchReportRow.decision} styleKey={researchReportRow.decision} styles={DECISION_STYLE} />
              <span className="text-xs text-black/50 dark:text-white/50">conviction {researchReportRow.conviction}/5</span>
              <Badge text={researchReportRow.gateStatus} styleKey={researchReportRow.gateStatus} styles={GATE_STATUS_STYLE} />
            </div>
          </div>

          <p className="mt-3 text-xs text-black/40 dark:text-white/40">
            data as of {researchReportRow.dataAsOf.toLocaleDateString("en-US")} · review by {researchReport.verdict.reviewDate}
            {researchReportRow.obsidianPath ? ` · exported to Obsidian: ${researchReportRow.obsidianPath}` : ""}
          </p>

          <p className="mt-3 text-sm leading-relaxed text-black/80 dark:text-white/80">{researchReport.verdict.thesis}</p>

          {researchReport.expectationGap && (
            <p className="mt-3 text-sm text-black/60 dark:text-white/60">
              <span className="font-medium">Expectation gap (reverse DCF):</span>{" "}
              {researchReport.expectationGap.classification.replace(/-/g, " ")} — implied{" "}
              {(researchReport.expectationGap.impliedGrowthRate * 100).toFixed(1)}% vs. achievable{" "}
              {(researchReport.expectationGap.achievableGrowthRate * 100).toFixed(1)}% growth
            </p>
          )}

          {positionSize && (
            <p className="mt-3 text-sm text-black/60 dark:text-white/60">
              <span className="font-medium">Suggested position size:</span> {positionSize.suggestedWeightPct.toFixed(1)}% of capital
              <span className="text-xs text-black/40 dark:text-white/40"> (inverse-volatility sizing, {(positionSize.annualizedVol * 100).toFixed(1)}% annualized vol — a starting point, not an allocator)</span>
              {sameSectorWatchlistCount > 0 && (
                <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">
                  {sameSectorWatchlistCount} other watchlist ticker{sameSectorWatchlistCount === 1 ? "" : "s"} already in {stock.sector} — worth checking sector concentration before sizing this in.
                </span>
              )}
            </p>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">Bulls</h3>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-black/80 dark:text-white/80">
                {(researchReport.bulls ?? []).map((b, i) => (
                  <li key={i}>{b.claim}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">Bears</h3>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-black/80 dark:text-white/80">
                {(researchReport.bears ?? []).map((b, i) => (
                  <li key={i}>{b.claim}</li>
                ))}
              </ul>
            </div>
          </div>

          {(researchReport.moat ?? []).length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">Moat</h3>
              <ul className="mt-2 space-y-1 text-sm text-black/80 dark:text-white/80">
                {researchReport.moat.map((m, i) => (
                  <li key={i}>
                    <span className="font-medium">{m.title}</span>{" "}
                    <span className="text-xs text-black/50 dark:text-white/50">({m.strength})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
              Invalidation triggers
            </h3>
            <TriggerTable triggers={researchReport.verdict.invalidationTriggers ?? []} />
          </div>

          {(() => {
            // confirmationTriggers is a schema field added after some already-persisted
            // ResearchReport.payload rows were written -- TypeScript's StockReport type promises
            // it's always an array, but that's only true for reports generated after this field
            // existed. A real older row (GOOGL, from earlier this session) crashed the page on
            // .length before this fallback was added -- payload is untyped Json in the DB, so the
            // type system can't catch a pre-existing row missing a field added later.
            const confirmationTriggers = researchReport.verdict.confirmationTriggers ?? [];
            if (researchReport.verdict.decision !== "WAIT" || confirmationTriggers.length === 0) return null;
            return (
              <div className="mt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
                  Confirmation triggers (WAIT → GO)
                </h3>
                <TriggerTable triggers={confirmationTriggers} />
              </div>
            );
          })()}
        </section>
      )}

      {stock.latestOverallScore != null && (
        <section className="mt-8 rounded-lg border border-black/10 p-4 dark:border-white/15">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
                Snowflake Score
              </h2>
              <div className="mt-1 text-3xl font-bold tabular-nums">{stock.latestOverallScore.toFixed(0)}<span className="text-base font-normal text-black/40 dark:text-white/40">/100</span></div>
              <p className="mt-1 text-xs text-black/40 dark:text-white/40">
                Ranked against other {stock.market} stocks in the universe · as of {stock.latestScoreDate?.toLocaleDateString("en-US")}
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <dt className="text-black/50 dark:text-white/50"><DimensionLabel label="Value" detail={dims?.value} /></dt>
                <dd className="text-right tabular-nums">{stock.latestValueScore?.toFixed(1) ?? "—"} / 5</dd>
                <dt className="text-black/50 dark:text-white/50"><DimensionLabel label="Future Growth" detail={dims?.future} /></dt>
                <dd className="text-right tabular-nums">{stock.latestFutureScore?.toFixed(1) ?? "—"} / 5</dd>
                <dt className="text-black/50 dark:text-white/50"><DimensionLabel label="Past Performance" detail={dims?.past} /></dt>
                <dd className="text-right tabular-nums">{stock.latestPastScore?.toFixed(1) ?? "—"} / 5</dd>
                <dt className="text-black/50 dark:text-white/50"><DimensionLabel label="Financial Health" detail={dims?.health} /></dt>
                <dd className="text-right tabular-nums">{stock.latestHealthScore?.toFixed(1) ?? "—"} / 5</dd>
                <dt className="text-black/50 dark:text-white/50"><DimensionLabel label="Dividend" detail={dims?.dividend} /></dt>
                <dd className="text-right tabular-nums">{stock.latestDividendScore?.toFixed(1) ?? "—"} / 5</dd>
                <dt className="text-black/50 dark:text-white/50"><DimensionLabel label="Momentum" detail={dims?.momentum} /></dt>
                <dd className="text-right tabular-nums">{stock.latestMomentumScore?.toFixed(1) ?? "—"} / 5</dd>
              </dl>
            </div>
            <div className="w-full max-w-sm flex-1">
              <SnowflakeChart
                data={[
                  { dimension: "Value", score: stock.latestValueScore },
                  { dimension: "Future", score: stock.latestFutureScore },
                  { dimension: "Past", score: stock.latestPastScore },
                  { dimension: "Health", score: stock.latestHealthScore },
                  { dimension: "Dividend", score: stock.latestDividendScore },
                ]}
              />
            </div>
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Size &amp; Value
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          <StatCard label="Market Cap" value={`${fmtCompact(stock.marketCap)} ${stock.currency ?? ""}`} />
          <StatCard label="Market Cap (USD)" value={fmtCompact(stock.marketCapUsd)} />
          <StatCard label="P/E (TTM)" value={fmtNum(stock.peRatio, { maximumFractionDigits: 2 })} />
          <StatCard label="Forward P/E" value={fmtNum(stock.forwardPe, { maximumFractionDigits: 2 })} />
          <StatCard label="P/B" value={fmtNum(stock.pbRatio, { maximumFractionDigits: 2 })} />
          <StatCard label="P/S" value={fmtNum(stock.psRatio, { maximumFractionDigits: 2 })} />
          <StatCard label="EV/EBITDA" value={fmtNum(stock.evToEbitda, { maximumFractionDigits: 2 })} />
          <StatCard label="Analyst Target" value={fmtMoney(stock.analystTargetPrice, stock.currency)} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Profitability &amp; Health
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          <StatCard label="ROE" value={fmtPct(stock.roe)} />
          <StatCard label="ROA" value={fmtPct(stock.roa)} />
          <StatCard label="Gross Margin" value={fmtPct(stock.grossMargin)} />
          <StatCard label="Operating Margin" value={fmtPct(stock.operatingMargin)} />
          <StatCard label="Net Margin" value={fmtPct(stock.netMargin)} />
          <StatCard label="Debt / Equity" value={fmtNum(stock.debtToEquity, { maximumFractionDigits: 2 })} />
          <StatCard label="Current Ratio" value={fmtNum(stock.currentRatio, { maximumFractionDigits: 2 })} />
          <StatCard label="Quick Ratio" value={fmtNum(stock.quickRatio, { maximumFractionDigits: 2 })} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Dividend &amp; Ownership
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          <StatCard label="Dividend Yield" value={fmtPct(stock.dividendYield)} />
          <StatCard label="Payout Ratio" value={fmtPct(stock.payoutRatio)} />
          <StatCard label="Insider Held" value={fmtPct(stock.heldPercentInsiders)} />
          <StatCard label="Institution Held" value={fmtPct(stock.heldPercentInstitutions)} />
        </div>
      </section>

      {annualHistory.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
            Financial History (Annual)
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-black/10 dark:border-white/15 text-left text-black/50 dark:text-white/50">
                  <th className="py-2 pr-4 font-medium">Year</th>
                  <th className="py-2 pr-4 font-medium">Revenue</th>
                  <th className="py-2 pr-4 font-medium">Net Income</th>
                  <th className="py-2 pr-4 font-medium">EPS</th>
                  <th className="py-2 pr-4 font-medium">Free Cash Flow</th>
                </tr>
              </thead>
              <tbody>
                {annualHistory.map((year) => (
                  <tr key={year.id} className="border-b border-black/5 dark:border-white/10">
                    <td className="py-2 pr-4">{year.period}</td>
                    <td className="py-2 pr-4">{fmtCompact(year.revenue)}</td>
                    <td className="py-2 pr-4">{fmtCompact(year.netIncome)}</td>
                    <td className="py-2 pr-4">{fmtNum(year.eps, { maximumFractionDigits: 2 })}</td>
                    <td className="py-2 pr-4">{fmtCompact(year.freeCashFlow)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {quarterlyHistory.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
            Financial History (Quarterly)
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-black/10 dark:border-white/15 text-left text-black/50 dark:text-white/50">
                  <th className="py-2 pr-4 font-medium">Quarter</th>
                  <th className="py-2 pr-4 font-medium">Revenue</th>
                  <th className="py-2 pr-4 font-medium">Net Income</th>
                  <th className="py-2 pr-4 font-medium">EPS</th>
                  <th className="py-2 pr-4 font-medium">Free Cash Flow</th>
                </tr>
              </thead>
              <tbody>
                {quarterlyHistory.map((quarter) => (
                  <tr key={quarter.id} className="border-b border-black/5 dark:border-white/10">
                    <td className="py-2 pr-4">{quarter.period}</td>
                    <td className="py-2 pr-4">{fmtCompact(quarter.revenue)}</td>
                    <td className="py-2 pr-4">{fmtCompact(quarter.netIncome)}</td>
                    <td className="py-2 pr-4">{fmtNum(quarter.eps, { maximumFractionDigits: 2 })}</td>
                    <td className="py-2 pr-4">{fmtCompact(quarter.freeCashFlow)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {stock.description && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">About</h2>
          <p className="mt-3 text-sm leading-relaxed text-black/70 dark:text-white/70">{stock.description}</p>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Deep Report
        </h2>
        <div className="mt-3">
          <DeepReportPanel
            ticker={stock.ticker}
            signedIn={user != null}
            initialReport={
              deepReport
                ? { content: deepReport.content, model: deepReport.model, createdAt: deepReport.createdAt.toISOString() }
                : null
            }
          />
        </div>
      </section>
    </main>
  );
}
