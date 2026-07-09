import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { canManageUserWithRole } from "@/lib/auth/permissions";
import type { UserRole } from "@/lib/generated/prisma/client";
import type { UserListItem } from "@/server/repositories/user.repository";

import { ROLE_LABELS } from "./schema";
import { UserActiveToggle } from "./user-active-toggle";
import { UserArchiveButton } from "./user-archive-button";
import { UserRestoreButton } from "./user-restore-button";

type UserListProps = {
  items: UserListItem[];
  nextCursor: string | null;
  /** Role of the current viewer — drives which action controls render. */
  currentUserRole: UserRole;
  /** Id of the current viewer — prevents self-archive button from showing. */
  currentUserId: string;
  /** When true the list includes archived rows with their restore controls. */
  showArchived: boolean;
};

const ROLE_TONE: Record<UserRole, "primary" | "warning" | "neutral"> = {
  SUPERADMIN: "primary",
  ADMIN: "warning",
  SUPERVISOR: "warning",
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

function archivedBadge() {
  return <Badge tone="danger">Archivado</Badge>;
}

// Listado de usuarios. Mobile-first (tarjetas) y, en desktop (lg+), tabla
// compacta para escanear. Acciones grandes y tocables para el gerente.
export function UserList({
  items,
  nextCursor,
  currentUserRole,
  currentUserId,
  showArchived,
}: UserListProps) {
  const isSuperAdmin = currentUserRole === "SUPERADMIN";

  if (items.length === 0) {
    return (
      <Card>
        <p className="text-base text-muted-foreground">
          {showArchived
            ? "No hay usuarios archivados."
            : "Todavía no hay usuarios. Creá el primero arriba."}
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Mobile / tablet: tarjetas apiladas. */}
      <div className="space-y-3 lg:hidden">
        {items.map((user) => {
          const isArchived = user.archivedAt !== null;
          const isSelf = user.id === currentUserId;
          const canManage = canManageUserWithRole(currentUserRole, user.role);

          return (
            <Card
              key={user.id}
              className={isArchived ? "space-y-3 opacity-60" : "space-y-3"}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-text">{user.name}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {user.email}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {roleBadge(user.role)}
                  {isArchived ? archivedBadge() : statusBadge(user.active)}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                {!isArchived && canManage ? (
                  <Link
                    href={`/admin/${user.id}`}
                    className="text-sm font-semibold text-primary hover:underline"
                  >
                    Editar
                  </Link>
                ) : null}
                {isArchived ? (
                  isSuperAdmin ? (
                    <UserRestoreButton userId={user.id} />
                  ) : null
                ) : canManage || (isSuperAdmin && !isSelf) ? (
                  <div className="flex items-center gap-2">
                    {canManage && (
                      <UserActiveToggle userId={user.id} active={user.active} />
                    )}
                    {isSuperAdmin && !isSelf && (
                      <UserArchiveButton
                        userId={user.id}
                        userName={user.name}
                      />
                    )}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </div>
            </Card>
          );
        })}
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
            {items.map((user) => {
              const isArchived = user.archivedAt !== null;
              const isSelf = user.id === currentUserId;
              const canManage = canManageUserWithRole(currentUserRole, user.role);

              return (
                <tr
                  key={user.id}
                  className={
                    isArchived
                      ? "border-b border-border opacity-60 last:border-0"
                      : "border-b border-border last:border-0"
                  }
                >
                  <td className="px-4 py-3 font-medium text-text">
                    {user.name}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {user.email}
                  </td>
                  <td className="px-4 py-3">{roleBadge(user.role)}</td>
                  <td className="px-4 py-3">
                    {isArchived ? archivedBadge() : statusBadge(user.active)}
                  </td>
                  <td className="px-4 py-3">
                    {isArchived ? (
                      isSuperAdmin ? (
                        <UserRestoreButton userId={user.id} />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )
                    ) : canManage || (isSuperAdmin && !isSelf) ? (
                      <div className="flex items-center gap-4">
                        {canManage ? (
                          <Link
                            href={`/admin/${user.id}`}
                            className="font-semibold text-primary hover:underline"
                          >
                            Editar
                          </Link>
                        ) : null}
                        {canManage && (
                          <UserActiveToggle
                            userId={user.id}
                            active={user.active}
                          />
                        )}
                        {isSuperAdmin && !isSelf && (
                          <UserArchiveButton
                            userId={user.id}
                            userName={user.name}
                          />
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
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
