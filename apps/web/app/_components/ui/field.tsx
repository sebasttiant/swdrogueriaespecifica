import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

type FieldProps = {
  /** Label text displayed above the input slot. */
  label: string;
  /** Associates the label with the input via htmlFor. Must match the child input's id. */
  htmlFor?: string;
  /** Validation error message shown below the input slot. */
  error?: string;
  /** Hint / helper text shown below the input slot (hidden when error is present). */
  hint?: string;
  /** Input slot — typically an Input, Select, or textarea element. */
  children: ReactNode;
  /** Optional className for the outer wrapper div. */
  className?: string;
};

/**
 * Shared form field wrapper.
 *
 * Renders a consistent layout: label → input slot → error or hint text.
 * Mirrors the `space-y-1.5` + label pattern used across all current forms.
 *
 * - Server-compatible (no client logic, no "use client").
 * - Error takes precedence over hint when both are provided.
 * - Label styling matches form convention: text-sm font-medium text-text.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: FieldProps) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-text"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
