"use client";

import { useActionState } from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils/cn";
import {
  updatePendingManagementStatusAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

type PendingQuickOrderProps = {
  pendingId: string;
  productName: string;
};

/**
 * "Ya lo pedí" sobre un pendiente, a un toque.
 *
 * Regla del gerente (reunión 2026-07-30): "que don Guillermo y Andrés le puedan
 * colocar el okay o el confirmado". Es el MISMO gesto que en faltantes y en la
 * cola de reportes: quien usa esto tiene 60 años y no debería aprender tres
 * interacciones distintas para decir la misma cosa.
 *
 * Escribe el estado de gestión `SOLICITADO`, que ya existía pero solo era
 * alcanzable desde un selector con cuatro opciones más un botón Guardar. El
 * selector completo sigue disponible en la vista detallada para los otros
 * estados (en búsqueda, cotizando, agotado).
 */
export function PendingQuickOrder({
  pendingId,
  productName,
}: PendingQuickOrderProps) {
  const [state, formAction, isPending] = useActionState(
    updatePendingManagementStatusAction,
    INITIAL_STATE,
  );

  return (
    <div className="space-y-1">
      <form action={formAction}>
        <input type="hidden" name="id" value={pendingId} />
        <input type="hidden" name="status" value="SOLICITADO" />
        <input type="hidden" name="expectedStatus" value="PENDIENTE" />
        <button
          type="submit"
          disabled={isPending}
          // Con decenas de filas, "Ya lo pedí" a secas no dice cuál.
          aria-label={`Marcar ${productName} como pedido al proveedor`}
          className={cn(
            "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg",
            "border border-success/30 bg-success/10 px-3 text-sm font-semibold",
            "text-success transition-colors hover:bg-success/20 disabled:opacity-50",
          )}
        >
          <Check className="size-4" aria-hidden />
          {isPending ? "…" : "Ya lo pedí"}
        </button>
      </form>

      {state.error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
