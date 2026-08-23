export function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-card-border bg-card/60 p-4">
      <div className="text-xs uppercase tracking-wide text-black/50 dark:text-white/50">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
