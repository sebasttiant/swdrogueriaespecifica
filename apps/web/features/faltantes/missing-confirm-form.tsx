"use client";

import { CheckCircle2 } from "lucide-react";
import { useActionState } from "react";

import { Button } from "@/app/_components/ui/button";
import { cn } from "@/lib/utils/cn";
import {
  confirmMissingItemAction,
  type MissingItemActionState,
} from "@/server/actions/missing-item.actions";

const INITIAL_STATE: MissingItemActionState = { error: null, ok: false };

type MissingConfirmFormProps = {
  id: string;
  className?: string;
};

// Autorización de gerencia: un check limpio, no un botón con
// texto. Es un client component porque necesita `useActionState` para traer el
// `{ ok, error }` que devuelve la Server Action al render y mostrarlo acá —
// antes el formulario descartaba el rechazo con un wrapper `Promise<void>`.
//
// Si un pedido concurrente pasó el faltante a PEDIDO (o ya fue confirmado), la
// Server Action devuelve `changed: false` y un mensaje; nunca pisa en silencio.
// La lista solo monta este formulario para items todavía autorizables
// (FALTANTE sin autorizar), así que el botón no se ofrece sobre estados muertos.
export function MissingConfirmForm({ id, className }: MissingConfirmFormProps) {
  const [state, formAction, isPending] = useActionState(
    confirmMissingItemAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className={cn("flex flex-col items-end gap-1", className)}>
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        variant="ghost"
        aria-label="Autorizar"
        title="Autorizar"
        disabled={isPending}
        className="px-2 text-success hover:bg-success/10"
      >
        <CheckCircle2 aria-hidden="true" className="h-6 w-6" />
      </Button>
      {state.error ? (
        <p role="alert" className="text-right text-xs font-medium text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}