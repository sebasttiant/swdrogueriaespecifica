"use client";

import { useActionState } from "react";

import { Button } from "@/app/_components/ui/button";
import {
  cancelPendingAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

type PendingCancelFormProps = {
  pendingId: string;
};

// Cancelación: rompe el compromiso con el cliente, por eso queda separada del
// flujo normal de entrega y solo se renderiza para quien tenga `canCancel`.
//
// Si una entrega concurrente completó el pendiente, la Server Action devuelve
// el rechazo y lo mostramos acá: cancelar nunca pisa una entrega en silencio.
export function PendingCancelForm({ pendingId }: PendingCancelFormProps) {
  const [state, formAction, isPending] = useActionState(
    cancelPendingAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={pendingId} />
      <Button
        type="submit"
        variant="danger"
        className="shrink-0"
        disabled={isPending}
      >
        {isPending ? "…" : "Cancelar"}
      </Button>
      {state.error ? (
        <p role="alert" className="text-right text-xs font-medium text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
