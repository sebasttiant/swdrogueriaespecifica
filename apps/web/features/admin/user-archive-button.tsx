"use client";

import { useState } from "react";
import { useActionState } from "react";

import { Alert } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import {
  archiveUserAction,
  type UserFormState,
} from "@/server/actions/user.actions";

const INITIAL_STATE: UserFormState = { error: null, ok: false };

type UserArchiveButtonProps = {
  userId: string;
  userName: string;
};

// Botón de archivado con confirmación en dos pasos (inline, sin dialog).
// Paso 1: botón "Archivar" → abre aviso de advertencia.
// Paso 2: aviso con "Cancelar" + "Confirmar archivado" que envía la acción.
// Muestra el error de regla inline (igual que user-active-toggle).
export function UserArchiveButton({ userId, userName }: UserArchiveButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, isPending] = useActionState(
    archiveUserAction,
    INITIAL_STATE,
  );

  if (confirming) {
    return (
      <div className="flex flex-col gap-2">
        <Alert tone="warning" role="status" className="max-w-xs text-xs">
          Esta acción quita el acceso de{" "}
          <span className="font-semibold">{userName}</span> y lo marca como
          eliminado. Podés restaurarlo después.
        </Alert>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="md"
            variant="outline"
            disabled={isPending}
            onClick={() => setConfirming(false)}
          >
            Cancelar
          </Button>
          <form action={formAction}>
            <input type="hidden" name="id" value={userId} />
            <Button
              type="submit"
              size="md"
              variant="danger"
              disabled={isPending}
            >
              {isPending ? "…" : "Confirmar archivado"}
            </Button>
          </form>
        </div>
        {state.error ? (
          <p
            role="alert"
            className="max-w-48 text-right text-xs font-medium text-danger"
          >
            {state.error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="md"
        variant="danger"
        onClick={() => setConfirming(true)}
      >
        Archivar
      </Button>
      {state.error ? (
        <p
          role="alert"
          className="max-w-48 text-right text-xs font-medium text-danger"
        >
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
