import Link from "next/link";
import { prisma } from "@/lib/prisma";

export default async function Home() {
  const stocks = await prisma.stock.findMany({
    where: { isActive: true },
    orderBy: [{ market: "asc" }, { ticker: "asc" }],
    select: { ticker: true, name: true, market: true, price: true, currency: true },
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-bold">akeguru</h1>
      <p className="mt-2 text-sm text-black/60 dark:text-white/60">
        Personal stock research — fundamentals, watchlist, screener, and a valuation score.
      </p>

      {stocks.length === 0 ? (
        <p className="mt-8 text-sm text-black/50 dark:text-white/50">
          No cached stocks yet — run <code className="rounded bg-black/5 px-1 dark:bg-white/10">npm run refresh</code>.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-black/10 dark:divide-white/10">
          {stocks.map((s) => (
            <li key={s.ticker}>
              <Link
                href={`/stock/${s.ticker}`}
                className="flex items-center justify-between gap-4 py-3 hover:bg-black/[.03] dark:hover:bg-white/[.05]"
              >
                <span>
                  <span className="font-medium">{s.ticker}</span>
                  <span className="ml-2 text-sm text-black/50 dark:text-white/50">{s.name}</span>
                </span>
                <span className="text-sm tabular-nums text-black/60 dark:text-white/60">
                  {s.price != null ? `${s.price} ${s.currency ?? ""}` : "—"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
