import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils/cn";

type EmptyStateProps = {
  // Optional decorative icon shown above the title.
  icon?: LucideIcon;
  title: string;
  description?: string;
  className?: string;
};

// Friendly, intentional empty state for dashboard sections and list views.
// Server-compatible (no client logic). Centered icon + title + optional hint so
// "no data" reads as a calm, expected state — never like a broken/missing UI.
export function EmptyState({
  icon: Icon,
  title,
  description,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-4 py-10 text-center",
        className,
      )}
    >
      {Icon ? (
        <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-6" aria-hidden />
        </span>
      ) : null}
      <h3 className="text-base font-semibold text-text">{title}</h3>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
