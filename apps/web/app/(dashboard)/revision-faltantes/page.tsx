import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { ReportQueueList } from "@/features/faltantes/report-queue-list";
import { parseReportQueuePage } from "@/features/faltantes/report-queue-paging";
import { requireCapability } from "@/lib/auth/require-role";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import { getMissingReportQueue } from "@/server/services/missing-report.service";

export const metadata: Metadata = { title: "Revisión de faltantes" };

// Cola operativa en vivo: nunca cachear.
export const dynamic = "force-dynamic";

// Cola de revisión de los reportes provisionales que cargan los vendedores.
//
// Vive en su propia ruta, separada de `/faltantes`, por dos razones: `/faltantes`
// es la pantalla operativa del vendedor en el celular y no debe cargar un tablero
// administrativo, y las dos colas paginan distinto (cursor allá, offset acá).
//
// El nav ya oculta el link a quien no puede revisar; este guard protege el
// acceso directo a la ruta.
export default async function RevisionFaltantesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requireCapability("canReviewMissingReports");

  const { page: rawPage } = await searchParams;
  const page = parseReportQueuePage(rawPage);

  const { groups, hasMore } = await getMissingReportQueue({
    page,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Revisión de faltantes"
        description="Lo que los vendedores reportaron. Marcá lo que ya pediste o descartá lo que no va."
      />

      <ReportQueueList groups={groups} page={page} hasMore={hasMore} />
    </div>
  );
}
