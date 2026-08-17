import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/session";
import { WatchlistButton } from "@/components/WatchlistButton";

export default async function WatchlistPage() {
  const user = await requireUser();

  const items = await prisma.watchlistItem.findMany({
    where: { userId: user.id },
    include: { stock: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-bold">Watchlist</h1>

      {items.length === 0 ? (
        <p className="mt-8 text-sm text-black/50 dark:text-white/50">
          Nothing here yet — add a stock from its detail page.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-black/10 dark:divide-white/10">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-4 py-3">
              <Link href={`/stock/${item.stock.ticker}`} className="hover:underline">
                <span className="font-medium">{item.stock.ticker}</span>
                <span className="ml-2 text-sm text-black/50 dark:text-white/50">{item.stock.name}</span>
              </Link>
              <div className="flex items-center gap-4">
                <span className="text-sm tabular-nums text-black/60 dark:text-white/60">
                  {item.stock.price != null ? `${item.stock.price} ${item.stock.currency ?? ""}` : "—"}
                </span>
                <WatchlistButton ticker={item.stock.ticker} watchlistItemId={item.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
