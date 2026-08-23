import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { SignOutButton } from "./SignOutButton";

export async function Nav() {
  const user = await getSessionUser();

  return (
    <header className="sticky top-0 z-10 border-b border-card-border bg-background/80 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" />
          akeguru
        </Link>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <Link href="/screener" className="text-black/60 hover:text-black dark:text-white/60 dark:hover:text-white">
            Screener
          </Link>
          <Link href="/watchlist" className="text-black/60 hover:text-black dark:text-white/60 dark:hover:text-white">
            Watchlist
          </Link>
          {user ? (
            <>
              <span className="hidden text-black/50 sm:inline dark:text-white/50">{user.email}</span>
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
