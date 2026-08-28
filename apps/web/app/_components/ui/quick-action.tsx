import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils/cn";

type QuickActionProps = {
  label: string;
  href: string;
  icon: LucideIcon;
  className?: string;
};

// Acción rápida: botón grande y tocable con el dedo (mobile-first).
export function QuickAction({ label, href, icon: Icon, className }: QuickActionProps) {
  return (
    <Link prefetch={false}
      href={href}
      className={cn(
        "flex min-h-24 flex-col items-center justify-center gap-2 rounded-[var(--radius-card)]",
        "border border-border bg-surface p-3 text-center shadow-sm transition-colors",
        "hover:border-primary hover:bg-primary/5 active:bg-primary/10",
        className,
      )}
    >
      <span className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-6" aria-hidden />
      </span>
      <span className="text-sm font-semibold text-text">{label}</span>
    </Link>
  );
}
