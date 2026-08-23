export type BadgeVariant = "go" | "wait" | "no_go" | "approved" | "rejected" | "pending" | "neutral";

const VARIANT_STYLE: Record<BadgeVariant, string> = {
  go: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  wait: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  no_go: "bg-red-500/15 text-red-700 dark:text-red-400",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  rejected: "bg-red-500/15 text-red-700 dark:text-red-400",
  pending: "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60",
  neutral: "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60",
};

export function Badge({ text, variant = "neutral" }: { text: string; variant?: BadgeVariant }) {
  return (
    <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${VARIANT_STYLE[variant]}`}>
      {text}
    </span>
  );
}

/** Verdict.decision ('GO'|'WAIT'|'NO_GO') -> Badge variant, shared everywhere a decision is shown
 *  (stock page, watchlist, screener) so the color mapping can't drift between pages. */
export function decisionToVariant(decision: string): BadgeVariant {
  if (decision === "GO") return "go";
  if (decision === "WAIT") return "wait";
  if (decision === "NO_GO") return "no_go";
  return "neutral";
}

/** ResearchReport.gateStatus ('APPROVED'|'REJECTED'|'PENDING') -> Badge variant. */
export function gateStatusToVariant(status: string): BadgeVariant {
  if (status === "APPROVED") return "approved";
  if (status === "REJECTED") return "rejected";
  return "pending";
}
