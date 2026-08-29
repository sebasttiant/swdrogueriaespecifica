"use client";

import { PackageCheck } from "lucide-react";

import { useActionState } from "@/lib/hooks/use-action-state";
import { cn } from "@/lib/utils/cn";
import {
  markMissingItemArrivedAction,
  type ReceiverActionState,
} from "@/server/actions/missing-receiver.actions";

const INITIAL_STATE: ReceiverActionState = { error: null, ok: false };

// Alto de dedo (44px): bodega marca la llegada de pie, con la caja en la mano
// y el celular en la otra. Es el mismo tamaño que usan las acciones de
// gerencia, porque el gesto es igual de repetitivo.
const ACTION_BASE =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors disabled:opacity-50";

type ReceiverArrivedButtonProps = {
  missingItemId: string;
  productName: string;
};

/**
 * "Ya llegó a bodega": la mercadería está físicamente acá.
 *
 * NO es "disponible para entregar". Ese salto lo da el registro de la entrada,
 * que carga lote, vencimiento y cantidad real. Marcar la llegada solo mueve el
 * faltante de PEDIDO a EN_BODEGA — el verde de la reunión: "ya llegó, pero no
 * lo cargaron al sistema".
 *
 * Por eso el botón dice "Ya llegó" y no "Recibido": recibir suena a terminado,
 * y todavía falta cargar la entrada. La fila salta a "En bodega", donde el
 * gesto siguiente ya es "Registrar entrada".
 *
 * Manda SOLO el id. Quién recibió sale de la sesión del lado del servidor:
 * aceptar un actor del formulario permitiría firmar la recepción a nombre de
 * otro, y esa firma es lo único que este registro existe para conservar.
 */
export function ReceiverArrivedButton({
  missingItemId,
  productName,
}: ReceiverArrivedButtonProps) {
  const [state, action, isPending] = useActionState(
    markMissingItemArrivedAction,
    INITIAL_STATE,
  );

  return (
    <div className="flex flex-col items-start gap-1">
      <form action={action}>
        <input type="hidden" name="missingItemId" value={missingItemId} />
        <button
          type="submit"
          disabled={isPending}
          // Con decenas de filas, "Ya llegó" a secas no dice cuál se marca.
          aria-label={`Marcar que llegó ${productName}`}
          className={cn(
            ACTION_BASE,
            "border-success/30 bg-success/10 text-success hover:bg-success/20",
          )}
        >
          <PackageCheck className="size-4" aria-hidden />
          {isPending ? "…" : "Ya llegó"}
        </button>
      </form>

      {/* Solo se informa el fallo. El éxito no necesita texto: la fila se va de
          "Ya pedidos" al revalidar, que es la confirmación más clara posible.
          El conflicto SÍ se dice: dos personas descargando el mismo pedido
          tocan la misma fila, y el servidor no pisa lo que ya estaba. */}
      {state.error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
