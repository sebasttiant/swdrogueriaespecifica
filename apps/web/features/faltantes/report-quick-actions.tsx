"use client";

import { useActionState } from "react";
import { Check, PackageCheck, X } from "lucide-react";

import { cn } from "@/lib/utils/cn";
import {
  resolveMissingReportsAction,
  type ResolveReportsActionState,
} from "@/server/actions/missing-report.actions";

const INITIAL_STATE: ResolveReportsActionState = { error: null, ok: false };

type ReportQuickActionsProps = {
  normalizedName: string;
  productName: string;
  // Qué vista se está mirando: decide qué acciones tienen sentido.
  //   pending → pedir o descartar (todavía hay que decidir).
  //   ordered → "ya llegó" (cierra el ciclo).
  //   discarded → ninguna: ya se decidió que no se pide.
  scope: "pending" | "ordered" | "discarded";
};

// Mismo alto de dedo y misma forma que las acciones de /faltantes. Que las dos
// pantallas se toquen igual es lo que hace que don Guillermo aprenda UN gesto y
// no tres.
// Compactos y de ancho fijo: con 40 reportes en una hora, dos botones a ancho
// completo por fila convierten la cola en un scroll infinito. Se conserva el
// alto de dedo (44px) porque se usa desde el celular.
const ACTION_BASE =
  "inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors disabled:opacity-50";

/**
 * Las dos salidas rápidas de la cola de revisión, a un toque.
 *
 * Antes la única forma de sacar un reporte de acá era vincularlo a un producto
 * del catálogo. Si el producto no estaba cargado —que es lo normal cuando el
 * vendedor pega un nombre desde Orión— el reporte quedaba atrapado y la cola
 * solo crecía. De eso se quejaba gerencia.
 *
 *   ✓ Ya lo pedí → gerencia lo compró; el reporte sale de la cola.
 *   ✗ Descartar  → nadie lo va a pedir; sale sin afirmar una compra.
 *
 * "Vincular producto" sigue disponible debajo para quien quiera el seguimiento
 * de stock del producto: esto es la otra salida, no su reemplazo.
 */
export function ReportQuickActions({
  normalizedName,
  productName,
  scope,
}: ReportQuickActionsProps) {
  const [state, formAction, isPending] = useActionState(
    resolveMissingReportsAction,
    INITIAL_STATE,
  );

  // Un reporte descartado ya no admite nada: no se vuelve a ofrecer una acción
  // que el servidor va a rechazar.
  if (scope === "discarded") return null;

  return (
    <div className="space-y-1">
      <div className="flex justify-end gap-2">
        {scope === "pending" ? (
          <>
            <form action={formAction}>
              <input type="hidden" name="normalizedName" value={normalizedName} />
              <input type="hidden" name="resolution" value="ORDERED" />
              <button
                type="submit"
                disabled={isPending}
                // Con varias filas en pantalla, "Ya lo pedí" a secas no dice cuál.
                aria-label={`Marcar ${productName} como pedido`}
                className={cn(
                  ACTION_BASE,
                  "border-success/30 bg-success/10 text-success hover:bg-success/20",
                )}
              >
                <Check className="size-4" aria-hidden />
                {isPending ? "…" : "Ya lo pedí"}
              </button>
            </form>

            <form action={formAction}>
              <input type="hidden" name="normalizedName" value={normalizedName} />
              <input type="hidden" name="resolution" value="DISCARDED" />
              <button
                type="submit"
                disabled={isPending}
                aria-label={`Descartar ${productName}`}
                className={cn(
                  ACTION_BASE,
                  "border-danger/30 bg-danger/10 text-danger hover:bg-danger/20",
                )}
              >
                <X className="size-4" aria-hidden />
                {isPending ? "…" : "Descartar"}
              </button>
            </form>
          </>
        ) : (
          // Ya pedido: lo único que falta es que llegue. Estos reportes no se
          // vinculan al catálogo, así que el cierre automático por entrada de
          // inventario no los alcanza: sin este botón quedarían pedidos para
          // siempre. NO mueve stock — eso lo hace la entrada de inventario.
          <form action={formAction}>
            <input type="hidden" name="normalizedName" value={normalizedName} />
            <input type="hidden" name="resolution" value="RECEIVED" />
            <input type="hidden" name="expectedStatus" value="ORDERED" />
            <button
              type="submit"
              disabled={isPending}
              aria-label={`Marcar que ${productName} ya llegó`}
              className={cn(
                ACTION_BASE,
                "border-success/30 bg-success/10 text-success hover:bg-success/20",
              )}
            >
              <PackageCheck className="size-4" aria-hidden />
              {isPending ? "…" : "Ya llegó"}
            </button>
          </form>
        )}
      </div>

      {/* Solo se informa el fallo: el éxito se ve solo, porque la tarjeta
          desaparece de la cola al revalidar. */}
      {state.error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
