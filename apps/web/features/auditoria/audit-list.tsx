import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import type { AuditResult } from "@/lib/generated/prisma/client";
import type { AuditLogListItem } from "@/server/repositories/audit.repository";

type AuditListProps = {
  items: AuditLogListItem[];
  nextCursor: string | null;
};

const RESULT: Record<
  AuditResult,
  { label: string; tone: "success" | "danger" }
> = {
  SUCCESS: { label: "Exitoso", tone: "success" },
  FAILURE: { label: "Fallido", tone: "danger" },
};

// Fecha/hora en zona horaria de Colombia: coherente con el resto del sistema.
const stampFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "short",
  timeStyle: "short",
});

function actor(log: AuditLogListItem): string {
  return log.user ? log.user.name : "Sistema";
}

function target(log: AuditLogListItem): string {
  return log.entityId ? `${log.entity} · ${log.entityId}` : log.entity;
}

// Listado de auditoría. Mobile-first (tarjetas apiladas) y, en desktop (lg+),
// una tabla compacta para escanear muchos eventos rápido. Responde quién ·
// cuándo · qué acción · sobre qué entidad · si fue exitoso.
export function AuditList({ items, nextCursor }: AuditListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-base text-muted-foreground">
          No hay registros de auditoría.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Mobile / tablet: tarjetas apiladas, táctiles. */}
      <div className="space-y-3 lg:hidden">
        {items.map((log) => {
          const result = RESULT[log.result];
          return (
            <Card
              key={log.id}
              className="flex items-start justify-between gap-3"
            >
              <div className="min-w-0 space-y-1">
                <p className="truncate font-semibold text-text">
                  <code className="text-sm">{log.action}</code>
                </p>
                <p className="text-sm text-muted-foreground">
                  {target(log)} · {log.module}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {actor(log)} · {stampFormatter.format(log.createdAt)}
                </p>
              </div>
              <Badge tone={result.tone} className="shrink-0">
                {result.label}
              </Badge>
            </Card>
          );
        })}
      </div>

      {/* Desktop: tabla compacta para escaneo rápido. */}
      <Card className="hidden overflow-x-auto p-0 lg:block">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Acción</th>
              <th className="px-4 py-3 font-medium">Entidad</th>
              <th className="px-4 py-3 font-medium">Módulo</th>
              <th className="px-4 py-3 font-medium">Usuario</th>
              <th className="px-4 py-3 font-medium">Fecha</th>
              <th className="px-4 py-3 font-medium">Resultado</th>
            </tr>
          </thead>
          <tbody>
            {items.map((log) => {
              const result = RESULT[log.result];
              return (
                <tr
                  key={log.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-3">
                    <code className="text-sm">{log.action}</code>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {target(log)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {log.module}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {actor(log)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {stampFormatter.format(log.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={result.tone}>{result.label}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            href={`/auditoria?cursor=${encodeURIComponent(nextCursor)}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}
