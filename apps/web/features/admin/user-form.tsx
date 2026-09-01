import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { assignableRolesFor } from "@/lib/auth/permissions";
import type { SessionRole } from "@/lib/auth/session";
import type { UserFormState } from "@/server/actions/user.actions";
import { ROLE_LABELS } from "./schema";

type UserFormProps = {
  actorRole: SessionRole;
  state: UserFormState;
  formAction: (formData: FormData) => void;
  isPending: boolean;
};

// Alta de usuario. Solo se monta dentro del módulo Admin (la página es ADMIN).
// El actor solo puede asignar roles a su altura o por debajo (techo por rango).
export function UserForm({ actorRole, state, formAction, isPending }: UserFormProps) {
  const assignableRoles = assignableRolesFor(actorRole);

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre" htmlFor="name">
          <Input id="name" name="name" required />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="off"
          />
        </Field>
        <Field label="Contraseña inicial" htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="mínimo 8 caracteres"
          />
        </Field>
        <Field label="Rol" htmlFor="create-user-role">
          <Select
            id="create-user-role"
            name="role"
            required
            defaultValue="OPERADOR"
          >
            {assignableRoles.map((role) => (
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
          Usuario creado.
        </p>
      ) : null}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Guardando…" : "Crear usuario"}
      </Button>
    </form>
  );
}
