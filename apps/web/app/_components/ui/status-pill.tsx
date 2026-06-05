import { cn } from "@/lib/utils/cn";

// Estado SIEMPRE comunicado con color + texto (nunca solo color) — accesible.
type StatusTone = "success" | "warning" | "danger" | "neutral";

const DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-muted-foreground",
};

const TEXT: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning-foreground",
  danger: "text-danger",
  neutral: "text-muted-foreground",
};

type StatusPillProps = {
  tone: StatusTone;
  label: string;
  className?: string;
};

export function StatusPill({ tone, label, className }: StatusPillProps) {
  return (
    <span
      className={cn("inline-flex items-center gap-2 text-sm font-medium", TEXT[tone], className)}
    >
      <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", DOT[tone])} />
      {label}
    </span>
  );
}
