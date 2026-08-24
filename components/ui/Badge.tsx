export type BadgeVariant = "go" | "wait" | "no_go" | "approved" | "rejected" | "pending" | "neutral";

// go/wait/nogo tokens (app/globals.css) carry both light and dark values, so a single class per
// variant works in both themes without a separate dark: override -- same reasoning the akeguru-
// dashboard.html design reference's .chip/.stamp classes use.
const VARIANT_STYLE: Record<BadgeVariant, string> = {
  go: "bg-go-bg text-go",
  wait: "bg-wait-bg text-wait",
  no_go: "bg-nogo-bg text-nogo",
  approved: "bg-go-bg text-go",
  rejected: "bg-nogo-bg text-nogo",
  pending: "bg-foreground/10 text-foreground-soft",
  neutral: "bg-foreground/10 text-foreground-soft",
};

export function Badge({ text, variant = "neutral" }: { text: string; variant?: BadgeVariant }) {
  return (
    <span className={`whitespace-nowrap rounded px-2 py-0.5 font-mono text-xs font-semibold uppercase tracking-wide ${VARIANT_STYLE[variant]}`}>
      {text}
    </span>
  );
}

/** Rotated "stamp" badge (the akeguru-dashboard.html reference's signature verdict marker) --
 *  bigger, bordered, and tilted -2deg, meant for a feed row's leading decision marker rather than
 *  an inline pill like Badge above. Same variant colors, different presentation. */
export function StampBadge({ text, variant }: { text: string; variant: "go" | "wait" | "no_go" }) {
  const style = {
    go: "text-go border-go bg-go-bg",
    wait: "text-wait border-wait bg-wait-bg",
    no_go: "text-nogo border-nogo bg-nogo-bg",
  }[variant];
  return (
    <span
      className={`inline-block min-w-16 shrink-0 -rotate-2 rounded border-[1.5px] px-2.5 py-1 text-center font-mono text-[11px] font-semibold tracking-wide ${style}`}
    >
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
