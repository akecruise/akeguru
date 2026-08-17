"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

export function WatchlistButton({
  ticker,
  watchlistItemId: initialId,
}: {
  ticker: string;
  watchlistItemId?: string | null;
}) {
  const { status } = useSession();
  const router = useRouter();
  const [itemId, setItemId] = useState<string | null>(initialId ?? null);
  const [pending, setPending] = useState(false);

  async function toggle() {
    if (status !== "authenticated") {
      router.push("/login");
      return;
    }
    setPending(true);
    try {
      if (itemId) {
        const res = await fetch(`/api/watchlist/${itemId}`, { method: "DELETE" });
        if (res.ok) {
          setItemId(null);
          router.refresh();
        }
      } else {
        const res = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker }),
        });
        if (res.ok) {
          const body = await res.json();
          setItemId(body.item.id);
          router.refresh();
        }
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60 ${
        itemId
          ? "border border-black/15 text-black/70 hover:bg-black/5 dark:border-white/20 dark:text-white/70 dark:hover:bg-white/10"
          : "bg-foreground text-background"
      }`}
    >
      {itemId ? "Remove" : "+ Watchlist"}
    </button>
  );
}
