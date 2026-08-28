import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils/cn";

import { Card } from "./card";

type KpiTone = "primary" | "success" | "warning" | "danger";

const ICON_WRAP: Record<KpiTone, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning-foreground",
  danger: "bg-danger/10 text-danger",
};

type KpiCardProps = {
  label: string;
  value: string | number;
  icon: LucideIcon;
  tone?: KpiTone;
  hint?: string;
  // Si se pasa, la tarjeta entera es un link tocable hacia ese módulo.
  href?: string;
};

// Tarjeta KPI grande y legible. Prioriza claridad en celular. Si recibe `href`,
// toda la tarjeta es tocable (área grande, mobile-first) y navega al módulo.
export function KpiCard({
  label,
  value,
  icon: Icon,
  tone = "primary",
  hint,
  href,
}: KpiCardProps) {
  const content = (
    <Card
      className={cn(
        "flex items-center gap-4",
        href && "transition-colors duration-150 ease-in-out hover:border-primary hover:bg-primary/5 active:bg-primary/10",
      )}
    >
      <span
        className={cn(
          "flex size-12 shrink-0 items-center justify-center rounded-xl",
          ICON_WRAP[tone],
        )}
      >
        <Icon className="size-6" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="truncate text-3xl font-bold leading-tight text-text">{value}</p>
        <p className="break-words text-sm font-medium text-muted-foreground">{label}</p>
        {hint ? <p className="mt-0.5 break-words text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </Card>
  );

  if (!href) return content;

  return (
    <Link prefetch={false} href={href} className="block rounded-[var(--radius-card)]">
      {content}
    </Link>
  );
}
