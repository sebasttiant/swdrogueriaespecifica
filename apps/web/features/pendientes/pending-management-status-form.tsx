"use client";

import { useActionState } from "@/lib/hooks/use-action-state";
import { Check, PackageX } from "lucide-react";

import {
  MANAGEMENT_STATUSES,
  MANAGEMENT_STATUS_LABELS,
  isManagementStatus,
  type ManagementStatus,
} from "@/features/pendientes/management-status";
import type { PendingStatus } from "@/lib/generated/prisma/client";
import { cn } from "@/lib/utils/cn";
import {
  updatePendingManagementStatusAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

type PendingManagementStatusFormProps = {
  pendingId: string;
  currentStatus: ManagementStatus | "POR_PEDIR" | PendingStatus;
  // En el listado la columna de al lado ya muestra el estado: repetirlo acá
  // sería decir dos veces lo mismo en la misma fila.
  hideCurrentLabel?: boolean;
};

// Los DOS desenlaces reales de un pendiente en compras, con las palabras del
// gerente: o lo pidió, o no se consigue. El resto de los estados existen, pero
// son la excepción y viven plegados.
const PRIMARY: { status: ManagementStatus; label: string; tone: "ok" | "no" }[] = [
  { status: "SOLICITADO", label: "Ya lo pedí", tone: "ok" },
  { status: "AGOTADO", label: "Agotado", tone: "no" },
];

const SECONDARY = MANAGEMENT_STATUSES.filter(
  (status) => !PRIMARY.some((primary) => primary.status === status),
);

const ACTION_BASE =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors disabled:opacity-50";

const TONE = {
  ok: "border-success/30 bg-success/10 text-success hover:bg-success/20",
  no: "border-danger/30 bg-danger/10 text-danger hover:bg-danger/20",
  muted: "border-border bg-muted/40 text-muted-foreground hover:bg-muted",
} as const;

// --------------------------------------------------------------------------
// Estado de gestión, sin selector.
//
// Antes esto era un `<select>` con cuatro opciones y un botón "Aplicar", visible
// SIEMPRE — incluso sobre un pendiente que ya estaba pedido. Le preguntaba al
// gerente algo que ya había respondido, y lo obligaba a dos gestos (elegir y
// aplicar) para lo que hace decenas de veces por día.
//
// Ahora:
//   · Por pedir  → dos botones de un toque: "Ya lo pedí" y "Agotado".
//   · Ya gestionado → se muestra el estado y NADA MÁS. Ya está decidido.
//     Cambiarlo es posible, pero detrás de un gesto explícito.
//
// Es el mismo gesto que en /faltantes y en la cola de revisión: un botón verde
// que dice lo que pasó. Una sola interacción para aprender en las tres pantallas.
// --------------------------------------------------------------------------
export function PendingManagementStatusForm({
  pendingId,
  currentStatus,
  hideCurrentLabel = false,
}: PendingManagementStatusFormProps) {
  const [state, formAction, isPending] = useActionState(
    updatePendingManagementStatusAction,
    INITIAL_STATE,
  );

  const settled = isManagementStatus(currentStatus);

  function statusButton(
    status: ManagementStatus,
    label: string,
    tone: keyof typeof TONE,
    icon?: React.ReactNode,
  ) {
    return (
      <form action={formAction} key={status}>
        <input type="hidden" name="id" value={pendingId} />
        <input type="hidden" name="status" value={status} />
        {/* Compare-and-set: se escribe solo si el pendiente sigue como esta
            pantalla lo vio. Dos gerentes mirando la misma lista no se pisan. */}
        <input type="hidden" name="expectedStatus" value={currentStatus} />
        <button
          type="submit"
          disabled={isPending}
          className={cn(ACTION_BASE, TONE[tone])}
        >
          {icon}
          {isPending ? "…" : label}
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-1.5">
      {settled ? (
        // Ya decidido: se informa y se sale del paso. Cambiar de opinión es
        // posible, pero no ocupa lugar en la pantalla de todos los días.
        <details className="group">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground hover:text-text [&::-webkit-details-marker]:hidden">
            {hideCurrentLabel ? null : (
              <span className="font-medium text-text">
                {MANAGEMENT_STATUS_LABELS[currentStatus]}
              </span>
            )}
            <span className="underline">cambiar</span>
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {MANAGEMENT_STATUSES.filter((status) => status !== currentStatus).map(
              (status) =>
                statusButton(status, MANAGEMENT_STATUS_LABELS[status], "muted"),
            )}
          </div>
        </details>
      ) : (
        <>
          {/* Los dos desenlaces reales, a un toque. */}
          <div className="flex flex-wrap gap-2">
            {PRIMARY.map((primary) =>
              statusButton(
                primary.status,
                primary.label,
                primary.tone,
                primary.tone === "ok" ? (
                  <Check className="size-4" aria-hidden />
                ) : (
                  <PackageX className="size-4" aria-hidden />
                ),
              ),
            )}
          </div>

          {/* Los estados intermedios existen para quien los use, pero no le
              roban lugar al camino de todos los días. */}
          {SECONDARY.length > 0 ? (
            <details className="group">
              <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-xs text-muted-foreground hover:text-text [&::-webkit-details-marker]:hidden">
                Otro estado
              </summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {SECONDARY.map((status) =>
                  statusButton(status, MANAGEMENT_STATUS_LABELS[status], "muted"),
                )}
              </div>
            </details>
          ) : null}
        </>
      )}

      {state.error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
