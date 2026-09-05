"use client";

import { useActionState } from "@/lib/hooks/use-action-state";
import { Clock, Link2, PackageCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  resolveWaitlistDecisionAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";
import { cn } from "@/lib/utils/cn";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

type PendingWaitlistDecisionFormProps = {
  pendingId: string;
  /** Lo que el cliente todavía no tiene. Es el número sobre el que decide. */
  remaining: number;
  /**
   * Si ya se le entregó una parte del pedido.
   *
   * Decide TRES cosas, y las tres por el mismo motivo. Ofrece cerrar, porque
   * cerrar un pendiente del que no salió nada es una cancelación, con su propio
   * flujo y su propio motivo. Elige las palabras: con una entrega en curso lo
   * que está en juego es EL RESTO; sin ninguna, el pedido entero. Y elige la
   * FORMA, por lo que se explica abajo.
   */
  hasPartialDelivery: boolean;
};

// --------------------------------------------------------------------------
// Qué hace el cliente con lo que todavía no tiene.
//
// Esta es la única puerta de entrada a la LISTA DE ESPERA. No hay un gesto
// aparte de "enviar a lista de espera" a propósito: sería una segunda marca que
// significa lo mismo que esta, y dos marcas que significan lo mismo terminan
// contradiciéndose. El cliente que responde "lo espera" YA está en la lista.
//
// Las respuestas son las que el vendedor ya usa en su tabla:
//
//   "Lo espera"          → lo aguarda; el pendiente sigue vivo
//   "Va con otro pedido" → se lo juntan con otro; el pendiente sigue vivo
//   "No los espera"      → se cierra con lo entregado (solo si hubo entrega)
//
// Las dos primeras dejan al cliente EN LISTA DE ESPERA. El pendiente no se
// mueve ni cambia de estado: sigue en su cola, y ADEMÁS aparece en la lista.
//
// La CANTIDAD no se pregunta acá: si hubo entrega ya la decidió esa entrega, y
// si no hubo, es el pedido entero.
//
// ---------------------------------------------------------------------------
// DOS FORMAS, y la diferencia es de densidad, no de capricho:
//
// - Tras una entrega parcial es un EVENTO: acaba de pasar algo y hay que
//   preguntar ahora. Se gana un panel con la pregunta y las tres salidas. Es la
//   forma que ya estaba en producción y no se toca.
//
// - Sin entrega es una acción DISPONIBLE, como corregir o cancelar: está ahí
//   por si el vendedor la necesita. Ahora aplica a casi toda la cola, así que
//   un panel con pregunta en cada fila inflaría la tarjeta del celular y
//   ensancharía la columna "Acción" de la tabla en TODAS las filas. Dos botones
//   del mismo tamaño que los vecinos, que entran en el mismo `flex-wrap`.
//
// Una acción que está siempre no puede gritar como una que aparece una vez.
// ---------------------------------------------------------------------------

const BUTTON_BASE =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors disabled:opacity-50";

const TONE = {
  wait: "border-border bg-muted/40 text-text hover:bg-muted",
  close: "border-success/30 bg-success/10 text-success hover:bg-success/20",
} as const;

function DecisionButton({
  value,
  label,
  icon: Icon,
  tone,
  disabled,
}: {
  value: string;
  label: string;
  icon: LucideIcon;
  tone: keyof typeof TONE;
  disabled: boolean;
}) {
  return (
    <button
      type="submit"
      name="decision"
      value={value}
      disabled={disabled}
      className={cn(BUTTON_BASE, TONE[tone])}
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </button>
  );
}

export function PendingWaitlistDecisionForm({
  pendingId,
  remaining,
  hasPartialDelivery,
}: PendingWaitlistDecisionFormProps) {
  const [state, action, pending] = useActionState(
    resolveWaitlistDecisionAction,
    INITIAL_STATE,
  );

  const error = state.error ? (
    <p role="alert" className="w-full text-xs text-danger">
      {state.error}
    </p>
  ) : null;

  // Sin entrega previa: dos botones y nada más. No lleva `w-full`, así que se
  // acomoda junto a las demás acciones en vez de empujarlas a otro renglón.
  if (!hasPartialDelivery) {
    return (
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={pendingId} />
        <DecisionButton
          value="espera"
          label="Lo espera"
          icon={Clock}
          tone="wait"
          disabled={pending}
        />
        <DecisionButton
          value="va_con_pedido"
          label="Va con otro pedido"
          icon={Link2}
          tone="wait"
          disabled={pending}
        />
        {error}
      </form>
    );
  }

  return (
    <form action={action} className="w-full space-y-2 rounded-lg bg-muted/30 p-2">
      <input type="hidden" name="id" value={pendingId} />
      <p className="text-xs font-medium text-muted-foreground">
        Faltan {remaining}. ¿Qué hace el cliente?
      </p>
      <div className="flex flex-wrap gap-2">
        <DecisionButton
          value="espera"
          label="Espera el resto"
          icon={Clock}
          tone="wait"
          disabled={pending}
        />
        <DecisionButton
          value="va_con_pedido"
          label="Va con otro pedido"
          icon={Link2}
          tone="wait"
          disabled={pending}
        />
        <DecisionButton
          value="cerrar"
          label="No los espera"
          icon={PackageCheck}
          tone="close"
          disabled={pending}
        />
      </div>
      {error}
    </form>
  );
}
