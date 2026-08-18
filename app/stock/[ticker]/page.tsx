import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth/session";
import { WatchlistButton } from "@/components/WatchlistButton";
import { SnowflakeChart } from "@/components/SnowflakeChart";
import { DeepReportPanel } from "@/components/DeepReportPanel";
import type { RawMetrics, DimensionDetail } from "@/lib/scoring";

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
          Data as of {stock.lastFetchedAt?.toLocaleDateString()} ({staleDays} days ago)
        </div>
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
                Ranked against other {stock.market} stocks in the universe · as of {stock.latestScoreDate?.toLocaleDateString()}
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
