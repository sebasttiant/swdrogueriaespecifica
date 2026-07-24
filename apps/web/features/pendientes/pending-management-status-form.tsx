"use client";

import { useActionState, useId } from "react";

import { Button } from "@/app/_components/ui/button";
import { Select } from "@/app/_components/ui/select";
import {
  MANAGEMENT_STATUSES,
  MANAGEMENT_STATUS_LABELS,
  isManagementStatus,
} from "@/features/pendientes/management-status";
import type { PendingStatus } from "@/lib/generated/prisma/client";
import {
  updatePendingManagementStatusAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

type PendingManagementStatusFormProps = {
  pendingId: string;
  currentStatus: PendingStatus;
};

// Selector de estado de gestión (gerencia/compras): comunica en qué punto está
// la búsqueda del producto. Solo se renderiza para quien tenga
// `canOrderMissingItems`; el vendedor ve el badge, no este control. La UI es
// cosmética: la Server Action re-chequea la capability del lado del server.
export function PendingManagementStatusForm({
  pendingId,
  currentStatus,
}: PendingManagementStatusFormProps) {
  const [state, formAction, isPending] = useActionState(
    updatePendingManagementStatusAction,
    INITIAL_STATE,
  );
  const selectId = useId();

  // Si el pendiente ya está en un estado de gestión, el selector arranca en él;
  // si todavía es PENDIENTE, arranca en el primero de la lista.
  const defaultStatus = isManagementStatus(currentStatus)
    ? currentStatus
    : MANAGEMENT_STATUSES[0];

  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <input type="hidden" name="id" value={pendingId} />
      <label
        htmlFor={selectId}
        className="text-xs font-medium text-muted-foreground"
      >
        Estado de gestión
      </label>
      {/* Mobile-first: en el celular el select y el botón se apilan; en pantalla
          ancha van en línea. Targets `min-h-11` para el pulgar. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          id={selectId}
          name="status"
          defaultValue={defaultStatus}
          disabled={isPending}
          className="sm:max-w-xs"
        >
          {MANAGEMENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {MANAGEMENT_STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
        <Button
          type="submit"
          variant="secondary"
          className="min-h-11 shrink-0"
          disabled={isPending}
        >
          {isPending ? "…" : "Aplicar"}
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
