import Link from "next/link";

import { cn } from "@/lib/utils/cn";
import {
  REPORT_PERIODS,
  REPORT_PERIOD_LABEL,
  type ReportsPeriod,
} from "@/server/services/reports.service";

type PeriodFilterProps = {
  active: ReportsPeriod;
};

// Control segmentado del período del reporte. Son links (?period=…) para que la
// página server se vuelva a renderizar con los datos del rango elegido.
export function PeriodFilter({ active }: PeriodFilterProps) {
  return (
    <div
      className="inline-flex rounded-lg border border-border bg-surface p-1"
      role="group"
      aria-label="Período del reporte"
    >
      {REPORT_PERIODS.map((period) => {
        const isActive = period === active;
        return (
          <Link
            key={period}
            href={`/reportes?period=${period}`}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {REPORT_PERIOD_LABEL[period]}
          </Link>
        );
      })}
    </div>
  );
}
