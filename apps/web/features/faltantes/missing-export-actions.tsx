"use client";

import { FileSpreadsheet, FileText, Printer } from "lucide-react";

import { Button } from "@/app/_components/ui/button";
import { cn } from "@/lib/utils/cn";

// Acciones de export de la cola de faltantes (Mejora 3). Mismo patrón que
// `ReportActions`, deliberado por la experiencia en iPhone (90% del uso):
//  - PDF → impresión nativa del navegador (window.print). Sin dependencias; en
//    iPhone: Compartir → Imprimir → guardar como PDF.
//  - Excel / CSV → links a la ruta de servidor que devuelve el archivo con
//    Content-Disposition, más confiable que un blob del navegador en Safari iOS.
// Se ocultan al imprimir (print:hidden) para no salir en el PDF.

const downloadLinkClass = cn(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-btn)] px-4 text-base font-semibold transition-colors duration-150 ease-in-out",
  "border border-border bg-surface text-text hover:bg-muted",
);

export function MissingExportActions() {
  return (
    <div className="flex flex-wrap gap-2 print:hidden">
      <Button variant="outline" className="gap-2" onClick={() => window.print()}>
        <Printer className="size-4" aria-hidden />
        Descargar PDF
      </Button>

      <a href="/faltantes/export?format=xlsx" className={downloadLinkClass}>
        <FileSpreadsheet className="size-4" aria-hidden />
        Descargar Excel
      </a>

      <a href="/faltantes/export?format=csv" className={downloadLinkClass}>
        <FileText className="size-4" aria-hidden />
        Descargar CSV
      </a>
    </div>
  );
}
