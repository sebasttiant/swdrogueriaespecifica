"use client";

import { FileSpreadsheet, Printer } from "lucide-react";

import { Button } from "@/app/_components/ui/button";
import { cn } from "@/lib/utils/cn";
import type { ReportsPeriod } from "@/server/services/reports.service";

type ReportActionsProps = {
  period: ReportsPeriod;
};

// Acciones de exportación del reporte. Se ocultan al imprimir (print:hidden):
//  - PDF → impresión nativa del navegador. En iPhone: Compartir → Imprimir →
//    guardar como PDF. Sin dependencias y con los gráficos incluidos.
//  - Excel → link a la ruta de servidor que devuelve el .xlsx (Content-Disposition),
//    más confiable que un blob en Safari iOS.
export function ReportActions({ period }: ReportActionsProps) {
  return (
    <div className="flex flex-wrap gap-2 print:hidden">
      <Button
        variant="outline"
        className="gap-2"
        onClick={() => window.print()}
      >
        <Printer className="size-4" aria-hidden />
        Descargar PDF
      </Button>

      <a
        href={`/reportes/export?period=${period}`}
        className={cn(
          "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-btn)] px-4 text-base font-semibold transition-colors duration-150 ease-in-out",
          "border border-border bg-surface text-text hover:bg-muted",
        )}
      >
        <FileSpreadsheet className="size-4" aria-hidden />
        Descargar Excel
      </a>
    </div>
  );
}
