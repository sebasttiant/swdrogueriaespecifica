import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import type { UserRole } from "@/lib/generated/prisma/client";
import type { UserListItem } from "@/server/repositories/user.repository";

import { ROLE_LABELS } from "./schema";
import { UserActiveToggle } from "./user-active-toggle";

type UserListProps = {
  items: UserListItem[];
  nextCursor: string | null;
};

const ROLE_TONE: Record<UserRole, "primary" | "warning" | "neutral"> = {
  ADMIN: "primary",
  LIDER: "warning",
  OPERADOR: "neutral",
};

function roleBadge(role: UserRole) {
  return <Badge tone={ROLE_TONE[role]}>{ROLE_LABELS[role]}</Badge>;
}

function statusBadge(active: boolean) {
  return (
    <Badge tone={active ? "success" : "neutral"}>
      {active ? "Activo" : "Inactivo"}
    </Badge>
  );
}

// Listado de usuarios. Mobile-first (tarjetas) y, en desktop (lg+), tabla
// compacta para escanear. Acciones grandes y tocables para el gerente.
export function UserList({ items, nextCursor }: UserListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-base text-muted-foreground">
          Todavía no hay usuarios. Creá el primero arriba.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Mobile / tablet: tarjetas apiladas. */}
      <div className="space-y-3 lg:hidden">
        {items.map((user) => (
          <Card key={user.id} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold text-text">{user.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {user.email}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {roleBadge(user.role)}
                {statusBadge(user.active)}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Link
                href={`/admin/${user.id}`}
                className="text-sm font-semibold text-primary hover:underline"
              >
                Editar
              </Link>
              <UserActiveToggle userId={user.id} active={user.active} />
            </div>
          </Card>
        ))}
      </div>

      {/* Desktop: tabla compacta. */}
      <Card className="hidden overflow-x-auto p-0 lg:block">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Nombre</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Rol</th>
              <th className="px-4 py-3 font-medium">Estado</th>
              <th className="px-4 py-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {items.map((user) => (
              <tr key={user.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3 font-medium text-text">{user.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{user.email}</td>
                <td className="px-4 py-3">{roleBadge(user.role)}</td>
                <td className="px-4 py-3">{statusBadge(user.active)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-4">
                    <Link
                      href={`/admin/${user.id}`}
                      className="font-semibold text-primary hover:underline"
                    >
                      Editar
                    </Link>
                    <UserActiveToggle userId={user.id} active={user.active} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            href={`/admin?cursor=${encodeURIComponent(nextCursor)}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}
