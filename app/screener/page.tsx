import Link from "next/link";
import { queryScreener, parseScreenerFilters, listSectors, SCREENER_SORT_FIELDS } from "@/lib/screener";
import { rankStocks, rankingWeightsSchema, DEFAULT_RANKING_WEIGHTS } from "@/lib/ranking";

function fmtNum(v: number | null | undefined, opts?: Intl.NumberFormatOptions): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("en-US", opts).format(v);
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

function fmtCompact(v: number | null | undefined): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}

const inputClass =
  "w-full rounded-md border border-black/15 px-2 py-1.5 text-sm dark:border-white/20 dark:bg-transparent";
const labelClass = "flex flex-col gap-1 text-xs text-black/60 dark:text-white/60";

export default async function ScreenerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const rawParams = await searchParams;
  const parsed = parseScreenerFilters(rawParams);
  const filters = parsed.success ? parsed.data : {};

  const s = (key: string) => (typeof rawParams[key] === "string" ? (rawParams[key] as string) : "");
  const isRanked = s("sortBy") === "rank";
  const weights = rankingWeightsSchema.parse({
    fundamental: s("fundamentalWeight") || undefined,
    momentum: s("momentumWeight") || undefined,
  });

  const sectorsPromise = listSectors();
  let stocks: Array<Awaited<ReturnType<typeof queryScreener>>["stocks"][number] & { rankScore?: number | null }>;
  let priceFilterIgnored: boolean;

  if (isRanked) {
    // Weighted ranking re-sorts anyway, so pull a larger unsorted-by-score candidate pool
    // (still respecting every filter) and rank it here instead of at the DB level.
    const candidates = await queryScreener({ ...filters, sortBy: undefined, limit: 200 });
    const ranked = rankStocks(candidates.stocks, weights).slice(0, filters.limit ?? 100);
    stocks = ranked.map((r) => ({ ...r.stock, rankScore: r.rankScore }));
    priceFilterIgnored = candidates.priceFilterIgnored;
  } else {
    const result = await queryScreener(filters);
    stocks = result.stocks;
    priceFilterIgnored = result.priceFilterIgnored;
  }

  const sectors = await sectorsPromise;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-bold">Screener</h1>
      <p className="mt-1 text-sm text-black/50 dark:text-white/50">
        Filters read straight from the daily-refreshed cache — no live fetches.
      </p>

      <form method="get" className="mt-6 grid grid-cols-2 gap-3 rounded-lg border border-black/10 p-4 sm:grid-cols-4 dark:border-white/15">
        <label className={labelClass}>
          Market
          <select name="market" defaultValue={s("market")} className={inputClass}>
            <option value="">All</option>
            <option value="TH">Thailand</option>
            <option value="US">US</option>
          </select>
        </label>
        <label className={labelClass}>
          Sector
          <select name="sector" defaultValue={s("sector")} className={inputClass}>
            <option value="">All</option>
            {sectors.map((sec) => (
              <option key={sec} value={sec}>
                {sec}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          P/E max
          <input type="number" step="any" name="peMax" defaultValue={s("peMax")} className={inputClass} />
        </label>
        <label className={labelClass}>
          ROE min (e.g. 0.15 = 15%)
          <input type="number" step="any" name="roeMin" defaultValue={s("roeMin")} className={inputClass} />
        </label>
        <label className={labelClass}>
          Dividend yield min (e.g. 0.03 = 3%)
          <input
            type="number"
            step="any"
            name="dividendYieldMin"
            defaultValue={s("dividendYieldMin")}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Debt/Equity max
          <input
            type="number"
            step="any"
            name="debtToEquityMax"
            defaultValue={s("debtToEquityMax")}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Market cap min (USD)
          <input
            type="number"
            step="any"
            name="marketCapUsdMin"
            defaultValue={s("marketCapUsdMin")}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Market cap max (USD)
          <input
            type="number"
            step="any"
            name="marketCapUsdMax"
            defaultValue={s("marketCapUsdMax")}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Snowflake score min (0-100)
          <input
            type="number"
            step="any"
            min="0"
            max="100"
            name="overallScoreMin"
            defaultValue={s("overallScoreMin")}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Price min <span className="text-black/35 dark:text-white/35">(needs a single market)</span>
          <input type="number" step="any" name="priceMin" defaultValue={s("priceMin")} className={inputClass} />
        </label>
        <label className={labelClass}>
          Price max <span className="text-black/35 dark:text-white/35">(needs a single market)</span>
          <input type="number" step="any" name="priceMax" defaultValue={s("priceMax")} className={inputClass} />
        </label>
        <label className={labelClass}>
          Sort by
          <select name="sortBy" defaultValue={s("sortBy") || "marketCapUsd"} className={inputClass}>
            <option value="rank">Weighted rank (fundamental + momentum)</option>
            {SCREENER_SORT_FIELDS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Sort direction
          <select name="sortDir" defaultValue={s("sortDir") || "desc"} className={inputClass}>
            <option value="desc">High to low</option>
            <option value="asc">Low to high</option>
          </select>
        </label>
        <label className={labelClass}>
          Fundamental weight <span className="text-black/35 dark:text-white/35">(rank sort only)</span>
          <input
            type="number"
            min="0"
            max="100"
            name="fundamentalWeight"
            defaultValue={s("fundamentalWeight") || String(DEFAULT_RANKING_WEIGHTS.fundamental)}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Momentum weight <span className="text-black/35 dark:text-white/35">(rank sort only)</span>
          <input
            type="number"
            min="0"
            max="100"
            name="momentumWeight"
            defaultValue={s("momentumWeight") || String(DEFAULT_RANKING_WEIGHTS.momentum)}
            className={inputClass}
          />
        </label>
        <div className="col-span-2 flex items-end gap-2 sm:col-span-4">
          <button type="submit" className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
            Filter
          </button>
          <Link href="/screener" className="text-sm text-black/50 hover:text-black dark:text-white/50 dark:hover:text-white">
            Reset
          </Link>
        </div>
      </form>

      {priceFilterIgnored && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
          Price filter ignored — select a single market to filter by price (THB and USD prices aren&apos;t comparable).
        </p>
      )}

      <p className="mt-6 text-sm text-black/50 dark:text-white/50">{stocks.length} result{stocks.length === 1 ? "" : "s"}</p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="border-b border-black/10 text-left text-black/50 dark:border-white/15 dark:text-white/50">
              <th className="py-2 pr-4 font-medium">Ticker</th>
              <th className="py-2 pr-4 font-medium">Sector</th>
              <th className="py-2 pr-4 font-medium">Price</th>
              <th className="py-2 pr-4 font-medium">Market Cap (USD)</th>
              <th className="py-2 pr-4 font-medium">P/E</th>
              <th className="py-2 pr-4 font-medium">ROE</th>
              <th className="py-2 pr-4 font-medium">Div Yield</th>
              <th className="py-2 pr-4 font-medium">D/E</th>
              <th className="py-2 pr-4 font-medium">Score</th>
              {isRanked && <th className="py-2 pr-4 font-medium">Rank Score</th>}
            </tr>
          </thead>
          <tbody>
            {stocks.map((stock) => (
              <tr key={stock.id} className="border-b border-black/5 hover:bg-black/[.02] dark:border-white/10 dark:hover:bg-white/[.04]">
                <td className="py-2 pr-4">
                  <Link href={`/stock/${stock.ticker}`} className="hover:underline">
                    <span className="font-medium">{stock.ticker}</span>
                    <span className="ml-2 text-black/50 dark:text-white/50">{stock.name}</span>
                  </Link>
                </td>
                <td className="py-2 pr-4 text-black/60 dark:text-white/60">{stock.sector ?? "—"}</td>
                <td className="py-2 pr-4">
                  {stock.price != null ? `${fmtNum(stock.price, { maximumFractionDigits: 2 })} ${stock.currency ?? ""}` : "—"}
                </td>
                <td className="py-2 pr-4">{fmtCompact(stock.marketCapUsd)}</td>
                <td className="py-2 pr-4">{fmtNum(stock.peRatio, { maximumFractionDigits: 2 })}</td>
                <td className="py-2 pr-4">{fmtPct(stock.roe)}</td>
                <td className="py-2 pr-4">{fmtPct(stock.dividendYield)}</td>
                <td className="py-2 pr-4">{fmtNum(stock.debtToEquity, { maximumFractionDigits: 2 })}</td>
                <td className="py-2 pr-4">{stock.latestOverallScore != null ? Math.round(stock.latestOverallScore) : "—"}</td>
                {isRanked && (
                  <td className="py-2 pr-4 font-medium">
                    {stock.rankScore != null ? stock.rankScore.toFixed(1) : "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {stocks.length === 0 && (
          <p className="py-8 text-center text-sm text-black/50 dark:text-white/50">No stocks match these filters.</p>
        )}
      </div>
    </main>
  );
}
