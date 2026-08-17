import { prisma } from "@/lib/prisma";

const STATUS_STYLES: Record<string, string> = {
  SUCCESS: "text-black/40 dark:text-white/40",
  PARTIAL: "text-amber-600 dark:text-amber-400",
  FAILED: "text-red-600 dark:text-red-400",
};

function relativeDays(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

export async function DataFreshnessBadge() {
  const log = await prisma.refreshLog.findFirst({
    where: { finishedAt: { not: null } },
    orderBy: { startedAt: "desc" },
  });

  if (!log) return null;

  const style = STATUS_STYLES[log.status] ?? "text-black/40 dark:text-white/40";

  return (
    <p className={`text-xs ${style}`}>
      Data refreshed {relativeDays(log.startedAt)}
      {log.status !== "SUCCESS" && ` · ${log.status.toLowerCase()}`}
      {log.status !== "SUCCESS" && log.tickersFailed > 0 && ` (${log.tickersFailed} tickers failed)`}
    </p>
  );
}
