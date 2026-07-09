import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { requireCapability } from "@/lib/auth/require-role";
import { AuditFilterBar } from "@/features/auditoria/audit-filter-bar";
import { AuditList } from "@/features/auditoria/audit-list";
import { getAuditLogs } from "@/server/services/audit.service";

export const metadata: Metadata = { title: "Auditoría" };

// Datos reales en vivo: nunca cachear.
export const dynamic = "force-dynamic";

// Módulo sensible: requiere la capability de auditoría. El nav ya oculta el link
// a otros roles; este guard protege el acceso directo a la ruta (sin la
// capability va a su home).
export default async function AuditoriaPage({
  searchParams,
}: {
  searchParams: Promise<{
    cursor?: string;
    action?: string;
    module?: string;
    result?: string;
    userText?: string;
    from?: string;
    to?: string;
  }>;
}) {
  await requireCapability("canViewAudit");

  const {
    cursor,
    action,
    module,
    result,
    userText,
    from,
    to,
  } = await searchParams;

  // Only accept known result values; discard invalid strings from the URL.
  const safeResult =
    result === "SUCCESS" || result === "FAILURE" ? result : undefined;

  const { items, nextCursor } = await getAuditLogs({
    cursor,
    action,
    module,
    result: safeResult,
    userText,
    from,
    to,
  });

  // Determine if any filter is active (for contextual empty-state copy in AuditList).
  const hasFilters = Boolean(action || module || safeResult || userText || from || to);

  // Active filters object to pass through to AuditList so "Ver más" can carry
  // all current filter params alongside the new cursor.
  const activeFilters: {
    action?: string;
    module?: string;
    result?: "SUCCESS" | "FAILURE";
    userText?: string;
    from?: string;
    to?: string;
  } = { action, module, result: safeResult, userText, from, to };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Auditoría"
        description="Quién, cuándo, qué acción, sobre qué registro y si fue exitoso. Eventos más recientes primero."
      />

      <AuditFilterBar
        action={action}
        module={module}
        result={safeResult}
        userText={userText}
        from={from}
        to={to}
      />

      <AuditList
        items={items}
        nextCursor={nextCursor}
        hasFilters={hasFilters}
        activeFilters={activeFilters}
      />
    </div>
  );
}
