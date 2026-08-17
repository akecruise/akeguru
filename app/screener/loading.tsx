function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/10 dark:bg-white/10 ${className}`} />;
}

export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <Bar className="h-7 w-40" />
      <Bar className="mt-3 h-4 w-80" />
      <Bar className="mt-6 h-64 w-full" />
      <div className="mt-6 flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Bar key={i} className="h-8 w-full" />
        ))}
      </div>
    </main>
  );
}
