import { NextResponse } from "next/server";
import { queryScreener, parseScreenerFilters } from "@/lib/screener";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = parseScreenerFilters(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid filters", issues: parsed.error.flatten() }, { status: 400 });
  }

  const { stocks, priceFilterIgnored } = await queryScreener(parsed.data);
  return NextResponse.json({ stocks, count: stocks.length, priceFilterIgnored });
}
