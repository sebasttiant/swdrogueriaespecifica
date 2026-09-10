"use client";

import { useState } from "react";

import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
import { newAttemptKey } from "@/features/pendientes/attempt-key";
import {
  deliverPendingAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

type PendingDeliverFormProps = {
  pendingId: string;
  remaining: number;
};

// Entrega parcial/total: cantidad acotada a lo que resta (`max`), pre-cargada
// con el resto completo para que "entregar todo" sea el caso de un solo tap.
//
// `min`/`max` son solo una ayuda del navegador: la Server Action revalida contra
// el estado real del pendiente bajo lock de fila. Cuando rechaza (formulario
// obsoleto, sobre-entrega, ya entregado/cancelado) mostramos ese mensaje acá en
// vez de descartarlo en silencio.
export function PendingDeliverForm({
  pendingId,
  remaining,
}: PendingDeliverFormProps) {
  const [state, formAction, isPending] = useActionState(
    deliverPendingAction,
    INITIAL_STATE,
  );
  const inputId = `quantity-${pendingId}`;

  // Clave de idempotencia del intento de ENTREGA. A diferencia del alta, este
  // formulario NO se remonta entre envíos —vive en la fila del pendiente
  // mientras queden entregas parciales por hacer—, así que la renovación no
  // puede apoyarse en un remonte.
  //
  // Se ajusta DURANTE el render (patrón oficial de React para "reaccionar a
  // un cambio", en vez de un `useEffect` que llamaría a `setState` de forma
  // encadenada): se compara `state` contra la última respuesta vista y, si
  // cambió y trajo `ok: true`, se renueva la clave ahí mismo. `state` cambia
  // de IDENTIDAD en cada respuesta de la acción —incluso entre dos éxitos
  // seguidos—, así que comparar el objeto entero (no solo `state.ok`) es lo
  // que permite que una segunda entrega parcial exitosa también renueve la
  // clave. Ante un rechazo se mantiene igual a propósito: es el mismo intento
  // reintentando, y reusarla ahí es justo lo que evita duplicar la entrega.
  const [attemptKey, setAttemptKey] = useState(() => newAttemptKey());
  const [lastSeenState, setLastSeenState] = useState(state);
  if (state !== lastSeenState) {
    setLastSeenState(state);
    if (state.ok) setAttemptKey(newAttemptKey());
  }

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">Entregar disponible: {remaining}</p>
      <div className="flex items-end gap-2">
        <input type="hidden" name="id" value={pendingId} />
        <input type="hidden" name="idempotencyKey" value={attemptKey} />
        <div className="w-20">
          <label htmlFor={inputId} className="sr-only">
            Cantidad a entregar
          </label>
          <Input
            id={inputId}
            name="quantity"
            type="number"
            min={1}
            max={remaining}
            step={1}
            defaultValue={remaining}
            required
            disabled={isPending}
          />
        </div>
        <Button type="submit" className="shrink-0" disabled={isPending}>
          {isPending ? "…" : "Entregar"}
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
