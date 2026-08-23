/**
 * Shared CompanyRelation graph traversal -- one hop out from a set of "core" tickers, in either
 * direction (supplier/customer/competitor/beneficiary of a core ticker, or a ticker that names a
 * core ticker as one of those). Factored out of scripts/theme-pipeline.ts (Phase 3) so
 * scripts/read-across.ts (Phase 4) can reuse the exact same traversal instead of re-deriving it --
 * both are "start from some tickers, walk CompanyRelation one hop, return the expanded set."
 */
import type { PrismaClient } from "../generated/prisma/client";

export interface RelatedTicker {
  ticker: string;
  role: string; // e.g. "core" or "SUPPLIER of MSFT" or "has MSFT as a COMPETITOR"
}

export async function resolveRelatedTickers(prisma: PrismaClient, coreTickers: string[], coreRole = "core"): Promise<RelatedTicker[]> {
  const members = new Map<string, RelatedTicker>();
  for (const ticker of coreTickers) members.set(ticker, { ticker, role: coreRole });

  if (!coreTickers.length) return [...members.values()];

  const relations = await prisma.companyRelation.findMany({
    where: { OR: [{ ticker: { in: coreTickers } }, { relatedTicker: { in: coreTickers } }] },
  });

  for (const r of relations) {
    // Outgoing (r.ticker is core, relatedTicker is the "other" one): "<relatedTicker> is a <TYPE> of <ticker>".
    if (coreTickers.includes(r.ticker) && !members.has(r.relatedTicker)) {
      members.set(r.relatedTicker, { ticker: r.relatedTicker, role: `${r.relationType} of ${r.ticker}` });
    }
    // Incoming (r.relatedTicker is core, r.ticker is the "other" one): from the expanded set's
    // perspective, r.ticker is related via the same relation, just named from the other side.
    if (coreTickers.includes(r.relatedTicker) && !members.has(r.ticker)) {
      members.set(r.ticker, { ticker: r.ticker, role: `has ${r.relatedTicker} as a ${r.relationType}` });
    }
  }

  return [...members.values()];
}
