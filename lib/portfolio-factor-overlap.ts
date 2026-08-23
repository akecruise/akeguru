/**
 * Portfolio Factor Overlap (Phase 5 roadmap item). Pure aggregation (same reasoning as
 * lib/regime.ts) -- scripts/portfolio-factor-overlap.ts supplies each watchlist ticker's latest
 * FactorExposure[] (Phase 2's Factor Sensitivity Agent output, lib/report/types.ts) and this counts,
 * per macro factor + direction, how many of those tickers actually share it.
 *
 * Uses WatchlistItem as the portfolio proxy: this app has no $ position/holdings tracking (see
 * lib/position-sizing.ts's doc comment for why that wasn't built either), and a user's watchlist is
 * the closest real, already-existing "the stocks I actually care about" set -- not scoped to GO
 * verdicts only, since a watchlist is explicitly a monitoring list, broader than "things I own."
 *
 * Only counts weight:'high' exposures -- that's literally what "high" means in factor-sensitivity.md
 * (a factor that materially moves the stock), so overlap on it is a real concentration signal; a
 * shared 'low'/'medium' exposure across a few names isn't the same kind of risk and would just add
 * noise here.
 */
import type { MacroFactor, FactorExposure } from "./report/types";

export const OVERLAP_MIN_COUNT = 3; // fewer than this isn't portfolio-wide concentration, just coincidence in a small watchlist -- documented, revisitable

export interface TickerFactorExposure {
  ticker: string;
  exposures: FactorExposure[];
}

export interface FactorOverlapRow {
  factor: MacroFactor;
  direction: "positive" | "negative";
  tickers: string[];
  count: number;
}

export function computeFactorOverlap(tickerExposures: TickerFactorExposure[]): FactorOverlapRow[] {
  const groups = new Map<string, FactorOverlapRow>(); // key = `${factor}:${direction}`

  for (const { ticker, exposures } of tickerExposures) {
    for (const e of exposures) {
      if (e.weight !== "high") continue;
      const key = `${e.factor}:${e.direction}`;
      const existing = groups.get(key);
      if (existing) existing.tickers.push(ticker);
      else groups.set(key, { factor: e.factor, direction: e.direction, tickers: [ticker], count: 1 });
    }
  }

  const rows = [...groups.values()];
  for (const row of rows) row.count = row.tickers.length;
  return rows.filter((r) => r.count >= OVERLAP_MIN_COUNT).sort((a, b) => b.count - a.count);
}

/**
 * Sector Concentration -- same "watchlist as portfolio proxy, catch what reviewing tickers one at a
 * time wouldn't easily spot" idea as computeFactorOverlap, but on Stock.sector instead of macro
 * factor exposure. Deliberately simpler: sector is always exactly one value per stock (not a
 * weighted judgment call the way factor exposure is), already sitting on every Stock row, so no
 * agent output or grounding is involved -- pure counting, same threshold (OVERLAP_MIN_COUNT) as the
 * factor version for consistency, not because 3 has been separately validated for sector risk.
 */
export interface TickerSector {
  ticker: string;
  sector: string | null;
}

export interface SectorConcentrationRow {
  sector: string;
  tickers: string[];
  count: number;
}

export function computeSectorConcentration(tickerSectors: TickerSector[]): SectorConcentrationRow[] {
  const groups = new Map<string, string[]>();

  for (const { ticker, sector } of tickerSectors) {
    if (!sector) continue; // no sector on record -- skip rather than group under a fake "unknown" bucket
    const tickers = groups.get(sector) ?? [];
    tickers.push(ticker);
    groups.set(sector, tickers);
  }

  return [...groups.entries()]
    .map(([sector, tickers]) => ({ sector, tickers, count: tickers.length }))
    .filter((r) => r.count >= OVERLAP_MIN_COUNT)
    .sort((a, b) => b.count - a.count);
}
