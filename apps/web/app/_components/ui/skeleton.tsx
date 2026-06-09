import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

type SkeletonProps = HTMLAttributes<HTMLDivElement>;

/**
 * Skeleton loading placeholder primitive.
 *
 * - Pure server-compatible presentational component (no client logic).
 * - Renders a pulsing muted block via `animate-pulse`.
 * - `motion-reduce:animate-none` disables the pulse locally when the user
 *   has requested reduced motion (local safeguard). A project-wide global
 *   rule will land in S6-13; this keeps S2 accessible on its own.
 * - Use `className` passthrough for size / shape overrides.
 * - Mirrors the existing UI primitive style (Badge, StatusPill, Alert).
 */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse motion-reduce:animate-none rounded bg-muted",
        className,
      )}
      {...props}
    />
  );
}
