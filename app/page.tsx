import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardHeading } from "@/components/ui/Card";
import { Badge, decisionToVariant } from "@/components/ui/Badge";
import { DataFreshnessBadge } from "@/components/DataFreshnessBadge";
import type { Market } from "../generated/prisma/client";

const MARKETS: Market[] = ["TH", "US", "HK"];

const REGIME_VARIANT: Record<string, "go" | "wait" | "no_go"> = {
  RISK_ON: "go",
  MIXED: "wait",
  RISK_OFF: "no_go",
};

export default async function Home() {
  const [stockCount, allReports, regimes] = await Promise.all([
    prisma.stock.count({ where: { isActive: true } }),
    // Same "order by ticker, then recency, keep first-per-ticker" dedupe pattern used throughout
    // scripts/{position-sizing,thesis-momentum,read-across}.ts -- dataAsOf is a date not a
    // timestamp, so createdAt breaks same-day-rerun ties.
    prisma.researchReport.findMany({
      orderBy: [{ ticker: "asc" }, { dataAsOf: "desc" }, { createdAt: "desc" }],
      select: { ticker: true, decision: true, conviction: true, dataAsOf: true },
    }),
    Promise.all(
      MARKETS.map((market) =>
        prisma.marketRegime.findFirst({ where: { market }, orderBy: { date: "desc" }, select: { market: true, classification: true, breadthPct: true } }),
      ),
    ),
  ]);

  const latestByTicker = new Map<string, (typeof allReports)[number]>();
  for (const r of allReports) if (!latestByTicker.has(r.ticker)) latestByTicker.set(r.ticker, r);
  const recentVerdicts = [...latestByTicker.values()]
    .sort((a, b) => b.dataAsOf.getTime() - a.dataAsOf.getTime())
    .slice(0, 6);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-bold">akeguru</h1>
      <p className="mt-2 text-sm text-black/60 dark:text-white/60">
        Personal stock research — fundamentals, watchlist, screener, and AI-assisted research verdicts.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeading>Tracked stocks</CardHeading>
          <p className="mt-1 text-2xl font-bold tabular-nums">{stockCount}</p>
          <div className="mt-2 text-xs text-black/40 dark:text-white/40"><DataFreshnessBadge /></div>
        </Card>
        <Card>
          <CardHeading>Research verdicts</CardHeading>
          <p className="mt-1 text-2xl font-bold tabular-nums">{latestByTicker.size}</p>
          <p className="mt-2 text-xs text-black/40 dark:text-white/40">tickers with a Compound OS report</p>
        </Card>
        <Card>
          <CardHeading>Market regime</CardHeading>
          <div className="mt-2 flex flex-wrap gap-2">
            {regimes.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => (
              <Badge key={r.market} text={`${r.market} ${r.classification}`} variant={REGIME_VARIANT[r.classification] ?? "neutral"} />
            ))}
            {regimes.every((r) => r === null) && <span className="text-xs text-black/40 dark:text-white/40">not computed yet</span>}
          </div>
        </Card>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/screener" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90">
          Open Screener
        </Link>
        <Link href="/watchlist" className="rounded-md border border-card-border px-4 py-2 text-sm font-medium hover:bg-black/[.03] dark:hover:bg-white/[.05]">
          My Watchlist
        </Link>
      </div>

      {recentVerdicts.length > 0 && (
        <section className="mt-10">
          <CardHeading className="mb-3">Recent research verdicts</CardHeading>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recentVerdicts.map((r) => (
              <Link key={r.ticker} href={`/stock/${r.ticker}`}>
                <Card
                  accent={r.decision === "GO" ? "go" : r.decision === "WAIT" ? "wait" : "no_go"}
                  className="transition-shadow hover:shadow-md"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{r.ticker}</span>
                    <Badge text={r.decision} variant={decisionToVariant(r.decision)} />
                  </div>
                  <p className="mt-1 text-xs text-black/40 dark:text-white/40">
                    conviction {r.conviction}/5 · {r.dataAsOf.toLocaleDateString("en-US")}
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
