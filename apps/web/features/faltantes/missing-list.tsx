import Link from "next/link";
import { CheckCircle2, PackageCheck } from "lucide-react";

import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { MissingItemStatus } from "@/lib/generated/prisma/client";
import { confirmMissingItemFormAction } from "@/server/actions/missing-item.actions";
import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";
import {
  computeDeadlineStatus,
  type DeadlineStatus,
} from "../pendientes/deadline-status";
import { groupMissingItems, type MissingGroupKey } from "./missing-grouping";

type MissingListProps = {
  items: MissingItemListItem[];
  nextCursor: string | null;
  canConfirm: boolean;
  // Instante compartido con `MissingSummary` para que ambas piezas hablen del
  // mismo momento (deadline badges + agrupación de urgencia).
  now: Date;
};

// Etiqueta y tono del encabezado de cada grupo de urgencia.
const GROUP_LABEL: Record<
  MissingGroupKey,
  { text: string; tone: "danger" | "warning" | "neutral" }
> = {
  VENCIDO: { text: "Vencidos", tone: "danger" },
  VENCE_PRONTO: { text: "Vencen pronto", tone: "warning" },
  EN_CURSO: { text: "En curso", tone: "neutral" },
};

const STATUS: Record<
  MissingItemStatus,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" }
> = {
  FALTANTE: { label: "Faltante", tone: "danger" },
  PEDIDO: { label: "Pedido", tone: "warning" },
  RECIBIDO: { label: "Recibido", tone: "success" },
  CANCELADO: { label: "Cancelado", tone: "neutral" },
};

const DEADLINE: Record<
  DeadlineStatus,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" }
> = {
  VENCIDO: { label: "Vencido", tone: "danger" },
  VENCE_PRONTO: { label: "Vence pronto", tone: "warning" },
  A_TIEMPO: { label: "A tiempo", tone: "success" },
  FINALIZADO: { label: "Finalizado", tone: "neutral" },
};

// Etiqueta de vencimiento del pendiente que originó el faltante (null = manual).
function deadlineBadge(origin: MissingItemListItem["origin"], now: Date) {
  if (!origin) return null;
  const deadline = DEADLINE[computeDeadlineStatus(origin.promisedAt, origin.status, now)];
  return <Badge tone={deadline.tone}>{deadline.label}</Badge>;
}

// Confirmación de gerencia: un check limpio (no un botón con texto). Solo se
// renderiza cuando el viewer puede confirmar (SUPERVISOR/ADMIN/SUPERADMIN). El label
// accesible y el title conservan el significado "OK gerencia".
function confirmForm(id: string, className?: string) {
  return (
    <form action={confirmMissingItemFormAction} className={className}>
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        variant="ghost"
        aria-label="Confirmar (OK gerencia)"
        title="OK gerencia"
        className="px-2 text-success hover:bg-success/10"
      >
        <CheckCircle2 aria-hidden="true" className="h-6 w-6" />
      </Button>
    </form>
  );
}

// Tarjeta mobile de un faltante. Extraída para reusarse dentro de cada
// sección de grupo sin duplicar el markup.
function missingCard(missing: MissingItemListItem, now: Date, canConfirm: boolean) {
  const status = STATUS[missing.status];
  const origin = missing.origin;
  return (
    <Card key={missing.id} className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-text sm:text-lg">
            {missing.product.name}
          </p>
          <p className="text-sm font-medium text-muted-foreground">
            Código {missing.product.code}
            {missing.originId ? " · auto" : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {deadlineBadge(origin, now)}
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            Cantidad: {missing.quantity} {missing.product.unit}
          </p>
          {origin ? (
            <>
              <p>Origen: pendiente{origin.customerName ? ` · ${origin.customerName}` : ""}</p>
              <p>Promesa: {formatBogotaDate(origin.promisedAt, { style: "datetime" })}</p>
            </>
          ) : null}
        </div>

        {canConfirm ? confirmForm(missing.id, "sm:self-end") : null}
      </div>
    </Card>
  );
}

// Fila desktop de un faltante. Misma razón de ser que `missingCard`.
function missingRow(missing: MissingItemListItem, now: Date, canConfirm: boolean) {
  const status = STATUS[missing.status];
  return (
    <tr key={missing.id} className="border-b border-border last:border-0">
      <td className="px-4 py-3 font-medium text-text">
        {missing.product.name}
        {missing.originId ? (
          <span className="ml-2 text-xs font-normal text-muted-foreground">auto</span>
        ) : null}
      </td>
      <td className="px-4 py-3 text-muted-foreground">{missing.product.code}</td>
      <td className="px-4 py-3 text-muted-foreground">
        {missing.quantity} {missing.product.unit}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          {deadlineBadge(missing.origin, now)}
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </td>
      {canConfirm ? (
        <td className="px-4 py-3">
          <div className="flex justify-end">{confirmForm(missing.id)}</div>
        </td>
      ) : null}
    </tr>
  );
}

// Listado presentacional (server component). Mobile-first: tarjetas apiladas.
// Desktop (lg+): tabla simple tipo checklist con scroll horizontal. Los items
// de la página actual se agrupan por urgencia operativa (ver
// `missing-grouping.ts`); el resumen global vive en `MissingSummary`.
export function MissingList({ items, nextCursor, canConfirm, now }: MissingListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={PackageCheck}
          title="Sin faltantes críticos"
          description="No hay faltantes pendientes por ahora. Todo al día."
        />
      </Card>
    );
  }

  const groups = groupMissingItems(items, now);

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Las secciones agrupan solo los faltantes de esta página. El resumen de arriba
        refleja el total global.
      </p>

      {groups.map((group) => {
        const label = GROUP_LABEL[group.key];
        const headingId = `faltantes-grupo-${group.key.toLowerCase()}`;

        return (
          <section key={group.key} className="space-y-3" aria-labelledby={headingId}>
            <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-text">
              {label.text}
              <Badge tone={label.tone}>{group.items.length}</Badge>
            </h2>

            {/* Mobile / tablet: tarjetas apiladas y tocables. */}
            <div className="space-y-3 lg:hidden">
              {group.items.map((missing) => missingCard(missing, now, canConfirm))}
            </div>

            {/* Desktop: tabla simple tipo checklist. Scroll horizontal si no entra. */}
            <Card className="hidden overflow-x-auto p-0 lg:block">
              <table className="w-full min-w-[48rem] text-left text-sm">
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Producto</th>
                    <th className="px-4 py-3 font-medium">Código</th>
                    <th className="px-4 py-3 font-medium">Cantidad</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    {canConfirm ? (
                      <th className="px-4 py-3 text-right font-medium">Acción</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((missing) => missingRow(missing, now, canConfirm))}
                </tbody>
              </table>
            </Card>
          </section>
        );
      })}

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            href={`/faltantes?cursor=${encodeURIComponent(nextCursor)}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}
