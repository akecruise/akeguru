export function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-card-border bg-card/60 p-4">
      <div className="text-xs uppercase tracking-wide text-foreground-faint">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
