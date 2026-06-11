"use client";

import { useActionState } from "react";

import { Button } from "@/app/_components/ui/button";
import {
  unarchiveUserAction,
  type UserFormState,
} from "@/server/actions/user.actions";

const INITIAL_STATE: UserFormState = { error: null, ok: false };

type UserRestoreButtonProps = {
  userId: string;
};

// Botón de restauración de usuario archivado. Un solo paso (restaurar no es
// destructivo). Muestra el error de regla inline si la acción falla.
export function UserRestoreButton({ userId }: UserRestoreButtonProps) {
  const [state, formAction, isPending] = useActionState(
    unarchiveUserAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={userId} />
      <Button type="submit" size="md" variant="outline" disabled={isPending}>
        {isPending ? "…" : "Restaurar"}
      </Button>
      {state.error ? (
        <p
          role="alert"
          className="max-w-48 text-right text-xs font-medium text-danger"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
