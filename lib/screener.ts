import { z } from "zod";
import { prisma } from "./prisma";
import type { Prisma } from "../generated/prisma/client";

export const SCREENER_SORT_FIELDS = [
  "marketCapUsd",
  "peRatio",
  "roe",
  "dividendYield",
  "price",
  "latestOverallScore",
  "latestMomentumScore",
  "pegRatio",
] as const;

export const LYNCH_CATEGORIES = ["fast_grower", "stalwart", "slow_grower", "cyclical"] as const;
export type ScreenerSortField = (typeof SCREENER_SORT_FIELDS)[number];

// Shared by the /screener page (SSR, direct call) and /api/screener (HTTP callers) so the
// two never drift on what counts as a valid filter.
export const screenerFiltersSchema = z.object({
  market: z.enum(["TH", "US", "HK"]).optional(),
  sector: z.string().min(1).optional(),
  peMin: z.coerce.number().optional(),
  peMax: z.coerce.number().optional(),
  roeMin: z.coerce.number().optional(),
  dividendYieldMin: z.coerce.number().optional(),
  debtToEquityMax: z.coerce.number().optional(),
  marketCapUsdMin: z.coerce.number().optional(),
  marketCapUsdMax: z.coerce.number().optional(),
  overallScoreMin: z.coerce.number().min(0).max(100).optional(),
  lynchCategory: z.enum(LYNCH_CATEGORIES).optional(),
  pegMax: z.coerce.number().optional(),
  // Only ever honored when `market` scopes to a single market — price isn't
  // comparable across THB/USD even after FX conversion (see review notes).
  priceMin: z.coerce.number().optional(),
  priceMax: z.coerce.number().optional(),
  // "rank"/"magicFormula"/"neff" are handled entirely by the caller (re-ranked client-of-Prisma,
  // same reasoning as "rank" -- magicFormula needs two independent rank orderings combined, neff
  // needs a formula no DB column holds) — accepted here purely so the whole filter object doesn't
  // fail to parse when one of them is selected.
  sortBy: z.union([z.enum(SCREENER_SORT_FIELDS), z.literal("rank"), z.literal("magicFormula"), z.literal("neff")]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type ScreenerFilters = z.infer<typeof screenerFiltersSchema>;

/** Parses raw string query params (URLSearchParams / Next.js searchParams) into validated filters, dropping empty strings. */
export function parseScreenerFilters(raw: Record<string, string | string[] | undefined>) {
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== "" && v !== undefined),
  );
  return screenerFiltersSchema.safeParse(cleaned);
}

export async function queryScreener(filters: ScreenerFilters) {
  const isSingleMarket = filters.market != null;

  const where: Prisma.StockWhereInput = {
    isActive: true,
    ...(filters.market && { market: filters.market }),
    ...(filters.sector && { sector: filters.sector }),
    ...((filters.peMin != null || filters.peMax != null) && {
      peRatio: {
        ...(filters.peMin != null && { gte: filters.peMin }),
        ...(filters.peMax != null && { lte: filters.peMax }),
      },
    }),
    ...(filters.roeMin != null && { roe: { gte: filters.roeMin } }),
    ...(filters.dividendYieldMin != null && { dividendYield: { gte: filters.dividendYieldMin } }),
    ...(filters.debtToEquityMax != null && { debtToEquity: { lte: filters.debtToEquityMax } }),
    ...(filters.overallScoreMin != null && { latestOverallScore: { gte: filters.overallScoreMin } }),
    ...(filters.lynchCategory && { lynchCategory: filters.lynchCategory }),
    // pegRatio is null for any stock the ratio doesn't apply to (negative P/E or growth — see
    // lib/lynch.ts) — excluded here the same way a numeric max filter naturally excludes nulls.
    ...(filters.pegMax != null && { pegRatio: { lte: filters.pegMax, not: null } }),
    ...((filters.marketCapUsdMin != null || filters.marketCapUsdMax != null) && {
      marketCapUsd: {
        ...(filters.marketCapUsdMin != null && { gte: filters.marketCapUsdMin }),
        ...(filters.marketCapUsdMax != null && { lte: filters.marketCapUsdMax }),
      },
    }),
    ...(isSingleMarket &&
      (filters.priceMin != null || filters.priceMax != null) && {
        price: {
          ...(filters.priceMin != null && { gte: filters.priceMin }),
          ...(filters.priceMax != null && { lte: filters.priceMax }),
        },
      }),
  };

  // Sorting by raw price across mixed currencies is the same bug as filtering by it — the
  // sortable fields only ever expose marketCapUsd (never raw marketCap) for this reason,
  // and price sort is only meaningful once callers have scoped to a single market anyway.
  // "rank"/"magicFormula"/"neff" aren't real columns — re-ranked outside this function (see
  // lib/ranking.ts, lib/magic-formula.ts, lib/neff.ts), so it falls back to the default DB sort here.
  const isSpecialSort = filters.sortBy === "rank" || filters.sortBy === "magicFormula" || filters.sortBy === "neff";
  const sortField = filters.sortBy && !isSpecialSort ? filters.sortBy : "marketCapUsd";

  const stocks = await prisma.stock.findMany({
    where,
    orderBy: { [sortField]: { sort: filters.sortDir ?? "desc", nulls: "last" } },
    take: Math.min(filters.limit ?? 100, 200),
  });

  return { stocks, priceFilterIgnored: !isSingleMarket && (filters.priceMin != null || filters.priceMax != null) };
}

export async function listSectors(): Promise<string[]> {
  const rows = await prisma.stock.findMany({
    where: { isActive: true, sector: { not: null } },
    select: { sector: true },
    distinct: ["sector"],
    orderBy: { sector: "asc" },
  });
  return rows.map((r) => r.sector).filter((s): s is string => s != null);
}
