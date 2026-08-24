"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Ticker lookup, not a general search index -- this app doesn't have one. Typing a ticker and
 *  pressing Enter jumps straight to its stock page (uppercased, same normalization the stock page
 *  itself already does on the URL param). */
export function SearchBar() {
  const router = useRouter();
  const [value, setValue] = useState("");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ticker = value.trim().toUpperCase();
    if (!ticker) return;
    router.push(`/stock/${encodeURIComponent(ticker)}`);
    setValue("");
  }

  return (
    <form onSubmit={onSubmit} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-card-border bg-background px-3 py-1.5 text-sm text-foreground-faint focus-within:border-accent">
      <span aria-hidden>◎</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="ค้นหา ticker…"
        aria-label="ค้นหา ticker"
        className="min-w-0 flex-1 bg-transparent font-mono text-foreground outline-none placeholder:text-foreground-faint placeholder:font-sans"
      />
    </form>
  );
}
