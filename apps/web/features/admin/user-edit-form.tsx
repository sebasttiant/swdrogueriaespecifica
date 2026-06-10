"use client";

import { useActionState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import {
  updateUserAction,
  type UserFormState,
} from "@/server/actions/user.actions";
import type { UserRole } from "@/lib/generated/prisma/client";
import { ASSIGNABLE_ROLES, ROLE_LABELS } from "./schema";

const INITIAL_STATE: UserFormState = { error: null, ok: false };

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
        <Field label="Nombre" htmlFor="name">
          <Input
            id="name"
            name="name"
            required
            defaultValue={user.name}
          />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            required
            defaultValue={user.email}
          />
        </Field>
        <Field label="Rol" htmlFor="role">
          <Select
            id="role"
            name="role"
            required
            defaultValue={user.role}
          >
            {ASSIGNABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </Select>
        </Field>
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
