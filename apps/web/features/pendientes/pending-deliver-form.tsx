"use client";

import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
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
    // Escribe: no se despacha sobre un build viejo.
    { mutation: true },
  );
  const inputId = `quantity-${pendingId}`;

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">Entregar disponible: {remaining}</p>
      <div className="flex items-end gap-2">
        <input type="hidden" name="id" value={pendingId} />
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
