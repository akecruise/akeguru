import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-lg flex-1 flex-col items-center justify-center px-6 py-20 text-center">
      <p className="text-sm font-medium uppercase tracking-wide text-black/40 dark:text-white/40">404</p>
      <h1 className="mt-2 text-2xl font-bold">Not found</h1>
      <p className="mt-2 text-sm text-black/60 dark:text-white/60">
        That page, or that ticker, isn&apos;t in the cache. It may not be in the tracked universe yet,
        or the daily refresh hasn&apos;t run since it was added.
      </p>
      <div className="mt-6 flex gap-3">
        <Link href="/" className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
          Home
        </Link>
        <Link
          href="/screener"
          className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20"
        >
          Screener
        </Link>
      </div>
    </main>
  );
}
