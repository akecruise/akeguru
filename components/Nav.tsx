import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { SignOutButton } from "./SignOutButton";
import { SearchBar } from "./SearchBar";

export async function Nav() {
  const user = await getSessionUser();

  return (
    <header className="sticky top-0 z-10 border-b border-card-border bg-background/80 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3">
        <Link href="/" className="shrink-0 font-mono text-xl font-semibold tracking-tight">
          ake<span className="text-accent">guru</span>
        </Link>
        <div className="hidden items-center gap-4 text-sm font-medium text-foreground-soft sm:flex">
          <Link href="/top-selected" className="hover:text-accent">Top Selected</Link>
          <Link href="/screener" className="hover:text-accent">Screener</Link>
          <Link href="/watchlist" className="hover:text-accent">Watchlist</Link>
        </div>
        <div className="order-last w-full sm:order-none sm:w-auto sm:flex-1 sm:max-w-md">
          <SearchBar />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-4 text-sm">
          <div className="flex items-center gap-4 text-foreground-soft sm:hidden">
            <Link href="/top-selected" className="hover:text-accent">Top Selected</Link>
            <Link href="/screener" className="hover:text-accent">Screener</Link>
            <Link href="/watchlist" className="hover:text-accent">Watchlist</Link>
          </div>
          {user ? (
            <>
              <span className="hidden text-foreground-faint sm:inline">{user.email}</span>
              <SignOutButton />
            </>
          ) : (
            <Link
              href="/login"
              className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-foreground hover:opacity-90"
            >
              Sign in
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
