import { NextResponse } from "next/server";
import { screenerFiltersSchema, queryScreener } from "@/lib/screener";
import { rankingWeightsSchema, rankStocks } from "@/lib/ranking";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);

  const filtersParsed = screenerFiltersSchema.safeParse(body?.filters ?? {});
  if (!filtersParsed.success) {
    return NextResponse.json({ error: "Invalid filters", issues: filtersParsed.error.flatten() }, { status: 400 });
  }
  const weightsParsed = rankingWeightsSchema.safeParse(body?.weights ?? {});
  if (!weightsParsed.success) {
    return NextResponse.json({ error: "Invalid weights", issues: weightsParsed.error.flatten() }, { status: 400 });
  }

  const limit = filtersParsed.data.limit ?? 100;
  // Pull a larger candidate pool than the final page size, ignoring the filters' own sortBy —
  // ranking re-sorts anyway, so the DB-level sort here is irrelevant.
  const { stocks: candidates, priceFilterIgnored } = await queryScreener({
    ...filtersParsed.data,
    limit: 200,
  });

  const ranked = rankStocks(candidates, weightsParsed.data).slice(0, limit);

  return NextResponse.json({
    results: ranked.map((r) => ({ ...r.stock, rankScore: r.rankScore })),
    count: ranked.length,
    priceFilterIgnored,
    weights: weightsParsed.data,
  });
}
