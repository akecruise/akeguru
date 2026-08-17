function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/10 dark:bg-white/10 ${className}`} />;
}

export default function Loading() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Bar className="h-4 w-40" />
          <Bar className="h-7 w-64" />
        </div>
        <Bar className="h-8 w-28" />
      </div>
      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Bar key={i} className="h-16" />
        ))}
      </div>
    </main>
  );
}
