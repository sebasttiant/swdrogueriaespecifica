import type { SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  className?: string;
};

/**
 * Shared select primitive.
 *
 * Standardizes the select styling duplicated across forms, reusing the same
 * base class string as the Input primitive:
 *   min-h-11 w-full rounded-[var(--radius-btn)] border border-border
 *   bg-muted/40 px-3 text-base text-text placeholder:text-muted-foreground
 *
 * - Server-compatible (no client logic, no "use client").
 * - Accepts all standard HTML select attributes including children (options).
 * - `className` passthrough via cn() for layout / override needs.
 */
export function Select({ className, children, ...props }: SelectProps) {
  return (
    <select
      className={cn(
        "min-h-11 w-full min-w-0 max-w-full rounded-[var(--radius-btn)] border border-border bg-muted/40 px-3 text-base text-text placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
