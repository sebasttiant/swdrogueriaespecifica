import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { ReportQueueList } from "@/features/faltantes/report-queue-list";
import { parseReportQueuePage } from "@/features/faltantes/report-queue-paging";
import {
  REPORT_QUEUE_SCOPES,
  REPORT_QUEUE_SCOPE_EMPTY,
  REPORT_QUEUE_SCOPE_LABELS,
  reportQueueScopeHref,
  resolveReportQueueScope,
} from "@/features/faltantes/report-queue-scope";
import { requireCapability } from "@/lib/auth/require-role";
import { cn } from "@/lib/utils/cn";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import { getMissingReportQueue } from "@/server/services/missing-report.service";

export const metadata: Metadata = { title: "Revisión de faltantes" };

// Cola operativa en vivo: nunca cachear.
export const dynamic = "force-dynamic";

// Cola de revisión de los faltantes que reportan los vendedores.
//
// Vive en su propia ruta, separada de `/faltantes`, porque las dos colas
// paginan distinto (cursor allá, offset acá). Pero se COMPORTAN igual: mismas
// tres pestañas, mismas palabras y el mismo gesto de un toque. Quien las usa
// tiene 60 años; que se parezcan es lo que evita tener que aprender dos cosas.
//
// El nav ya oculta el link a quien no puede revisar; este guard protege el
// acceso directo a la ruta.
export default async function RevisionFaltantesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; scope?: string }>;
}) {
  await requireCapability("canReviewMissingReports");

  const { page: rawPage, scope: rawScope } = await searchParams;
  const page = parseReportQueuePage(rawPage);
  const scope = resolveReportQueueScope(rawScope);

  const { groups, hasMore } = await getMissingReportQueue({
    page,
    pageSize: DEFAULT_PAGE_SIZE,
    scope,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Revisión de faltantes"
        description="Lo que los vendedores reportaron. Marcá lo que ya pediste o descartá lo que no va."
      />

      {/* Mismas pestañas que /faltantes, con las mismas palabras. Lo resuelto no
          se borra: se consulta acá al lado. */}
      <nav
        aria-label="Estado de los reportes"
        className="flex flex-wrap gap-2 text-sm font-semibold"
      >
        {REPORT_QUEUE_SCOPES.map((option) => (
          <Link prefetch={false}
            key={option}
            href={reportQueueScopeHref(option)}
            aria-current={scope === option ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center rounded-lg px-4 transition-colors",
              scope === option
                ? "bg-primary text-primary-foreground"
                : "bg-muted/60 text-muted-foreground hover:bg-muted",
            )}
          >
            {REPORT_QUEUE_SCOPE_LABELS[option]}
          </Link>
        ))}
      </nav>

      <ReportQueueList
        groups={groups}
        page={page}
        hasMore={hasMore}
        scope={scope}
        emptyTitle={REPORT_QUEUE_SCOPE_EMPTY[scope].title}
        emptyDescription={REPORT_QUEUE_SCOPE_EMPTY[scope].description}
      />
    </div>
  );
}
