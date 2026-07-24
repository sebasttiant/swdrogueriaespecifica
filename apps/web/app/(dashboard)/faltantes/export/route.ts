// Descarga de la cola de faltantes en CSV o Excel (.xlsx). Requiere la misma
// capability que la página (`canViewFaltantes`). Se sirve desde una ruta de
// servidor —no un blob en el cliente— porque Safari iOS maneja mucho mejor las
// descargas con Content-Disposition (la app es 90% iPhone). El PDF NO pasa por
// acá: es la impresión nativa del navegador (window.print) desde la lista.

import { requireCapability } from "@/lib/auth/require-role";
import { getMissingItemsForExport } from "@/server/services/missing-item.service";
import {
  buildMissingCsv,
  buildMissingWorkbookBuffer,
} from "@/server/services/missing-export.service";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  await requireCapability("canViewFaltantes");

  const format =
    new URL(request.url).searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const rows = await getMissingItemsForExport();
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "csv") {
    return new Response(buildMissingCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="faltantes-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const buffer = await buildMissingWorkbookBuffer(rows);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="faltantes-${stamp}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
