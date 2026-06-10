"use client";

import { useActionState } from "react";

import { Button } from "@/app/_components/ui/button";
import {
  setUserActiveAction,
  type UserFormState,
} from "@/server/actions/user.actions";

const INITIAL_STATE: UserFormState = { error: null, ok: false };

type UserActiveToggleProps = {
  userId: string;
  active: boolean;
};

// Botón de activar/desactivar. El destino es el estado opuesto al actual.
// Muestra el error de regla (p. ej. "último admin") sin romper la página.
export function UserActiveToggle({ userId, active }: UserActiveToggleProps) {
  const [state, formAction, isPending] = useActionState(
    setUserActiveAction,
    INITIAL_STATE,
  );
  const next = !active;

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={userId} />
      <input type="hidden" name="active" value={String(next)} />
      <Button
        type="submit"
        size="md"
        variant={active ? "danger" : "primary"}
        disabled={isPending}
      >
        {isPending ? "…" : active ? "Desactivar" : "Activar"}
      </Button>
      {state.error ? (
        <p role="alert" className="max-w-48 text-right text-xs font-medium text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
