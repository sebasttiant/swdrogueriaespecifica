// Descarga del reporte en Excel (.xlsx). Solo ADMIN/SUPERADMIN (mismo guard que
// la página). Respeta el filtro de período (?period=). Se sirve desde una ruta
// de servidor —no un blob en el cliente— porque Safari iOS maneja mucho mejor las
// descargas con Content-Disposition que los blobs generados en el navegador.

import { requireActiveRole } from "@/lib/auth/require-role";
import {
  getReportsAnalytics,
  parseReportsPeriod,
} from "@/server/services/reports.service";
import { buildReportsWorkbookBuffer } from "@/server/services/reports-export.service";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  await requireActiveRole("SUPERADMIN", "ADMIN");

  const period = parseReportsPeriod(
    new URL(request.url).searchParams.get("period") ?? undefined,
  );

  const now = new Date();
  const analytics = await getReportsAnalytics(period, now);
  const buffer = await buildReportsWorkbookBuffer(analytics, now);

  const filename = `reportes-drogueria-${period}-${now
    .toISOString()
    .slice(0, 10)}.xlsx`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
