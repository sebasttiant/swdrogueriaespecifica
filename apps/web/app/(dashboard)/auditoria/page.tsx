import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { requireActiveRole } from "@/lib/auth/require-role";
import { AuditList } from "@/features/auditoria/audit-list";
import { getAuditLogs } from "@/server/services/audit.service";

export const metadata: Metadata = { title: "Auditoría" };

// Datos reales en vivo: nunca cachear.
export const dynamic = "force-dynamic";

// Módulo sensible: solo ADMIN. El nav ya oculta el link a otros roles; este
// guard protege el acceso directo a la ruta (un no-admin va a su home).
export default async function AuditoriaPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  await requireActiveRole("SUPERADMIN", "ADMIN");

  const { cursor } = await searchParams;
  const { items, nextCursor } = await getAuditLogs({ cursor });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Auditoría"
        description="Quién, cuándo, qué acción, sobre qué registro y si fue exitoso. Eventos más recientes primero."
      />

      <AuditList items={items} nextCursor={nextCursor} />
    </div>
  );
}
