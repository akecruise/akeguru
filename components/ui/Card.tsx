import type { ReactNode } from "react";

const ACCENT_BORDER: Record<string, string> = {
  go: "border-l-4 border-l-go",
  wait: "border-l-4 border-l-wait",
  no_go: "border-l-4 border-l-nogo",
  neutral: "",
};

export function Card({
  children,
  className = "",
  accent = "neutral",
}: {
  children: ReactNode;
  className?: string;
  accent?: "go" | "wait" | "no_go" | "neutral";
}) {
  return (
    <div
      className={`rounded-xl border border-card-border bg-card p-5 shadow-sm ${ACCENT_BORDER[accent]} ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeading({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h2 className={`text-xs font-semibold uppercase tracking-wide text-foreground-faint ${className}`}>
      {children}
    </h2>
  );
}
