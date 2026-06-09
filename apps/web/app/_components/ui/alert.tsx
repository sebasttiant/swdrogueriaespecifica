import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

export type AlertTone = "danger" | "warning" | "success" | "neutral";

// Maps tone to background + border + text classes using the @theme tokens from globals.css.
// Mirrors the TONES pattern from badge.tsx — reuse existing tokens, no new colors.
const TONE_CLASSES: Record<AlertTone, string> = {
  danger: "bg-danger/10 border-danger/30 text-danger",
  warning: "bg-warning/10 border-warning/30 text-warning-foreground",
  success: "bg-success/10 border-success/30 text-success",
  neutral: "bg-muted border-border text-muted-foreground",
};

export type AlertProps = HTMLAttributes<HTMLDivElement> & {
  tone?: AlertTone;
  /** Accessibility role: use "alert" for danger (announced immediately), "status" for warning/info. */
  role?: "alert" | "status";
  children: ReactNode;
  className?: string;
};

/**
 * Alert / Notice presentational primitive.
 *
 * - Pure server-compatible component (no client logic, no state).
 * - Tones reuse the Tailwind 4 @theme tokens defined in globals.css.
 * - `role` defaults to "alert" for danger tone and "status" for all others.
 * - Use `className` passthrough for layout overrides (e.g. margins).
 */
export function Alert({
  tone = "neutral",
  role,
  children,
  className,
  ...props
}: AlertProps) {
  // Accessibility: danger alerts are announced immediately (role="alert");
  // informational notices use role="status" (polite queue).
  const resolvedRole = role ?? (tone === "danger" ? "alert" : "status");

  return (
    <div
      role={resolvedRole}
      className={cn(
        "rounded-lg border px-4 py-3 text-sm",
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
