"use client";

import { useActionState } from "@/lib/hooks/use-action-state";
import { Check, X } from "lucide-react";

import { cn } from "@/lib/utils/cn";
import {
  discardMissingItemsAction,
  markMissingItemsOrderedAction,
  type MissingItemActionState,
} from "@/server/actions/missing-item.actions";

const INITIAL_STATE: MissingItemActionState = { error: null, ok: false };

type MissingQuickActionsProps = {
  missingItemId: string;
  productName: string;
};

// Alto de dedo (44px) y ancho cómodo: el uso real es un gerente de 60 años
// marcando decenas de filas desde el celular, muchas veces de viaje.
const ACTION_BASE =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors disabled:opacity-50";

/**
 * Las dos salidas de un faltante, a UN TOQUE y sin abrir nada.
 *
 * Regla del gerente (reunión 2026-07-30): "yo marco los chulitos y ya lo que ya
 * pidió, un check que ya pidió y listo" · "que también haya forma de eliminarlos
 * sin pedirlos".
 *
 * Son dos acciones con significados OPUESTOS y por eso se ven distintas —color,
 * icono y texto—, nunca un "OK" ambiguo:
 *
 *   ✓ Pedido   → gerencia ya lo compró; la mercadería viene en camino.
 *   ✗ Descartar → nadie lo va a pedir (duplicado o ya no hace falta).
 *
 * Reutiliza las Server Actions masivas con un solo id: un único camino de
 * código para una fila y para ochenta, y una sola autorización que mantener.
 *
 * Sin diálogo de confirmación a propósito: nada se borra —ambas mueven la fila
 * a su vista— y un modal por fila, multiplicado por cientos, es exactamente el
 * "más pasos" que volvió inusable la pantalla.
 */
export function MissingQuickActions({
  missingItemId,
  productName,
}: MissingQuickActionsProps) {
  const [orderState, orderAction, isOrdering] = useActionState(
    markMissingItemsOrderedAction,
    INITIAL_STATE,
  );
  const [discardState, discardAction, isDiscarding] = useActionState(
    discardMissingItemsAction,
    INITIAL_STATE,
  );

  // Deshabilitar es cortesía contra el doble toque; la garantía real es la
  // idempotencia del servidor (el compare-and-set no vuelve a escribir).
  const busy = isOrdering || isDiscarding;
  const error = orderState.error ?? discardState.error;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <form action={orderAction}>
          <input type="hidden" name="ids" value={missingItemId} />
          <button
            type="submit"
            disabled={busy}
            // El nombre del producto va en el rótulo accesible: con decenas de
            // filas, "Pedido" a secas no dice cuál se está marcando.
            aria-label={`Marcar ${productName} como pedido`}
            className={cn(
              ACTION_BASE,
              "border-success/30 bg-success/10 text-success hover:bg-success/20",
            )}
          >
            <Check className="size-4" aria-hidden />
            {isOrdering ? "…" : "Pedido"}
          </button>
        </form>

        <form action={discardAction}>
          <input type="hidden" name="ids" value={missingItemId} />
          <button
            type="submit"
            disabled={busy}
            aria-label={`Descartar ${productName}`}
            className={cn(
              ACTION_BASE,
              "border-danger/30 bg-danger/10 text-danger hover:bg-danger/20",
            )}
          >
            <X className="size-4" aria-hidden />
            {isDiscarding ? "…" : "Descartar"}
          </button>
        </form>
      </div>

      {/* Solo se informa el fallo. El éxito no necesita texto: la fila se va de
          la cola al revalidar, que es la confirmación más clara posible. */}
      {error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
