import type { ReactNode } from "react";

const ACCENT_BORDER: Record<string, string> = {
  go: "border-l-4 border-l-emerald-500",
  wait: "border-l-4 border-l-amber-500",
  no_go: "border-l-4 border-l-red-500",
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
    <h2 className={`text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50 ${className}`}>
      {children}
    </h2>
  );
}
