"use client";

import { useActionState } from "react";

import { Button } from "@/app/_components/ui/button";
import {
  createUserAction,
  type UserFormState,
} from "@/server/actions/user.actions";
import { ASSIGNABLE_ROLES, ROLE_LABELS } from "./schema";

const INITIAL_STATE: UserFormState = { error: null, ok: false };

const inputClass =
  "min-h-11 w-full rounded-[var(--radius-btn)] border border-border bg-muted/40 px-3 text-base text-text placeholder:text-muted-foreground";

// Alta de usuario. Solo se monta dentro del módulo Admin (la página es ADMIN).
export function UserForm() {
  const [state, formAction, isPending] = useActionState(
    createUserAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="name" className="text-sm font-medium text-text">
            Nombre
          </label>
          <input id="name" name="name" required className={inputClass} />
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
            autoComplete="off"
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-sm font-medium text-text">
            Contraseña inicial
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="mínimo 8 caracteres"
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="role" className="text-sm font-medium text-text">
            Rol
          </label>
          <select id="role" name="role" required className={inputClass} defaultValue="OPERADOR">
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
          Usuario creado.
        </p>
      ) : null}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Guardando…" : "Crear usuario"}
      </Button>
    </form>
  );
}
