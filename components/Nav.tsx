import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { SignOutButton } from "./SignOutButton";

export async function Nav() {
  const user = await getSessionUser();

  return (
    <header className="border-b border-black/10 dark:border-white/15">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-3">
        <Link href="/" className="font-semibold">
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
            <Link href="/login" className="text-black/60 hover:text-black dark:text-white/60 dark:hover:text-white">
              Sign in
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
