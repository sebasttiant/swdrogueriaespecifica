"use client";

import { useActionState } from "react";

import { Button } from "@/app/_components/ui/button";
import {
  updateUserAction,
  type UserFormState,
} from "@/server/actions/user.actions";
import type { UserRole } from "@/lib/generated/prisma/client";
import { ASSIGNABLE_ROLES, ROLE_LABELS } from "./schema";

const INITIAL_STATE: UserFormState = { error: null, ok: false };

const inputClass =
  "min-h-11 w-full rounded-[var(--radius-btn)] border border-border bg-muted/40 px-3 text-base text-text placeholder:text-muted-foreground";

type UserEditFormProps = {
  user: { id: string; name: string; email: string; role: UserRole };
};

// Edición de datos del usuario (nombre, email, rol). La contraseña no se cambia
// en este slice. Solo ADMIN (la página la protege).
export function UserEditForm({ user }: UserEditFormProps) {
  const [state, formAction, isPending] = useActionState(
    updateUserAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="id" value={user.id} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="name" className="text-sm font-medium text-text">
            Nombre
          </label>
          <input
            id="name"
            name="name"
            required
            defaultValue={user.name}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium text-text">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            defaultValue={user.email}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="role" className="text-sm font-medium text-text">
            Rol
          </label>
          <select
            id="role"
            name="role"
            required
            defaultValue={user.role}
            className={inputClass}
          >
            {ASSIGNABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          Cambios guardados.
        </p>
      ) : null}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Guardando…" : "Guardar cambios"}
      </Button>
    </form>
  );
}
