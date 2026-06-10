import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  className?: string;
};

/**
 * Shared input primitive.
 *
 * Standardizes the `inputClass` string duplicated across forms:
 *   min-h-11 w-full rounded-[var(--radius-btn)] border border-border
 *   bg-muted/40 px-3 text-base text-text placeholder:text-muted-foreground
 *
 * - Server-compatible (no client logic, no "use client").
 * - Accepts all standard HTML input attributes.
 * - `className` passthrough via cn() for layout / override needs.
 */
export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        "min-h-11 w-full rounded-[var(--radius-btn)] border border-border bg-muted/40 px-3 text-base text-text placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
