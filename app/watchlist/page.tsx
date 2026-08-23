import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/session";
import { WatchlistButton } from "@/components/WatchlistButton";
import type { StockReport } from "@/lib/report/types";
import { computeFactorOverlap, computeSectorConcentration, type TickerFactorExposure, type TickerSector } from "@/lib/portfolio-factor-overlap";
import { Card } from "@/components/ui/Card";
import { Badge, decisionToVariant } from "@/components/ui/Badge";

const FACTOR_LABEL: Record<string, string> = {
  interest_rates: "interest rates",
  usd_strength: "USD strength",
  oil_price: "oil price",
  china_demand: "China demand",
  consumer_spending: "consumer spending",
  commodity_input_costs: "commodity input costs",
};

export default async function WatchlistPage() {
  const user = await requireUser();

  const items = await prisma.watchlistItem.findMany({
    where: { userId: user.id },
    include: { stock: true },
    orderBy: { createdAt: "desc" },
  });

  // Portfolio Factor Overlap (Phase 5) -- same computation as scripts/portfolio-factor-overlap.ts,
  // just reading straight off this page's own watchlist query instead of taking an email arg. Also
  // grabs `decision` here (same query) to show a badge per card below -- no extra round trip.
  const tickerExposures: TickerFactorExposure[] = [];
  const decisionByTicker = new Map<string, string>();
  for (const item of items) {
    // dataAsOf is a date, not a timestamp -- createdAt breaks same-day-rerun ties (same reasoning as
    // scripts/position-sizing.ts and app/stock/[ticker]/page.tsx's identical query).
    const report = await prisma.researchReport.findFirst({
      where: { ticker: item.stock.ticker },
      orderBy: [{ dataAsOf: "desc" }, { createdAt: "desc" }],
      select: { payload: true, decision: true },
    });
    if (!report) continue;
    decisionByTicker.set(item.stock.ticker, report.decision);
    const exposures = (report.payload as unknown as StockReport).factorSensitivity ?? [];
    tickerExposures.push({ ticker: item.stock.ticker, exposures });
  }
  const factorOverlap = computeFactorOverlap(tickerExposures);

  // Sector Concentration (Phase 5 extension) -- same "watchlist as portfolio proxy" idea as the
  // factor overlap above, but on Stock.sector: no ResearchReport needed, every watchlist item
  // already carries its sector from the initial query.
  const tickerSectors: TickerSector[] = items.map((item) => ({ ticker: item.stock.ticker, sector: item.stock.sector }));
  const sectorConcentration = computeSectorConcentration(tickerSectors);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-bold">Watchlist</h1>

      {(factorOverlap.length > 0 || sectorConcentration.length > 0) && (
        <Card accent="wait" className="mt-6">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Concentration</p>
          <ul className="mt-1 space-y-0.5 text-sm text-amber-700 dark:text-amber-400">
            {sectorConcentration.map((row) => (
              <li key={`sector-${row.sector}`}>
                {row.count} tickers ({row.tickers.join(", ")}) are all {row.sector}
              </li>
            ))}
            {factorOverlap.map((row) => (
              <li key={`${row.factor}-${row.direction}`}>
                {row.count} tickers ({row.tickers.join(", ")}) share a high-weight {row.direction} exposure to{" "}
                {FACTOR_LABEL[row.factor] ?? row.factor}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {items.length === 0 ? (
        <p className="mt-8 text-sm text-black/50 dark:text-white/50">
          Nothing here yet — add a stock from its detail page.
        </p>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => {
            const decision = decisionByTicker.get(item.stock.ticker);
            return (
              <Card
                key={item.id}
                accent={decision === "GO" ? "go" : decision === "WAIT" ? "wait" : decision === "NO_GO" ? "no_go" : "neutral"}
              >
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/stock/${item.stock.ticker}`} className="hover:underline">
                    <div className="font-semibold">{item.stock.ticker}</div>
                    <div className="text-sm text-black/50 dark:text-white/50">{item.stock.name}</div>
                  </Link>
                  {decision && <Badge text={decision} variant={decisionToVariant(decision)} />}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-sm tabular-nums text-black/60 dark:text-white/60">
                    {item.stock.price != null ? `${item.stock.price} ${item.stock.currency ?? ""}` : "—"}
                  </span>
                  <WatchlistButton ticker={item.stock.ticker} watchlistItemId={item.id} />
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}
