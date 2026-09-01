import { ArchiveX, SearchX, UserRoundX } from "lucide-react";

import {
  adminPageHref,
  hasActiveFilters,
  type UserFilters,
} from "@/features/admin/filters";
import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { cn } from "@/lib/utils/cn";
import { EmptyState } from "@/app/_components/ui/empty-state";
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
  /** Los filtros vigentes, para que paginar no los pierda. */
  filters: UserFilters;
  /** Role of the current viewer — drives which action controls render. */
  currentUserRole: UserRole;
  /** Id of the current viewer — prevents self-archive button from showing. */
  currentUserId: string;
  /** When true the list includes archived rows with their restore controls. */
  showArchived: boolean;
};

/**
 * Altura táctil del proyecto: 44 px. El área interactiva puede ser más alta que
 * el texto; lo que no puede es ser más chica que un dedo adulto.
 */
const ACCION_TACTIL =
  "inline-flex min-h-11 min-w-11 items-center justify-center font-semibold text-primary underline-offset-2 hover:underline";

const ROLE_TONE: Record<UserRole, "primary" | "warning" | "neutral"> = {
  SUPERADMIN: "primary",
  ADMIN: "warning",
  SUPERVISOR: "warning",
  OPERADOR: "neutral",
  BODEGA: "neutral",
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

/**
 * Por qué esta lista está vacía, y qué hacer al respecto.
 *
 * Son cuatro situaciones distintas y decir la equivocada desinforma. "No hay
 * usuarios archivados" cuando en realidad hay muchos y lo que no coincide es el
 * filtro no es un mensaje incompleto: es una afirmación falsa. Quien la lee
 * concluye que no hay a quién restaurar y se va.
 *
 * Cada estado ofrece la salida que corresponde: limpiar los filtros cuando el
 * problema son los filtros, y volver a la lista operativa cuando se está
 * mirando la otra.
 */
function VaciaPorque({ filters }: { filters: UserFilters }) {
  const conFiltros = hasActiveFilters(filters);

  if (filters.archived) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon={ArchiveX}
          title={
            conFiltros
              ? "No hay usuarios archivados con estos filtros."
              : "No hay usuarios archivados."
          }
          description={
            conFiltros
              ? "Puede haber usuarios archivados que no coinciden con la búsqueda."
              : "Los usuarios que archives van a aparecer acá."
          }
        />
      </div>
    );
  }

  if (conFiltros) {
    return (
      <EmptyState
        icon={SearchX}
        title="Sin coincidencias"
        description="Ningún usuario coincide con la búsqueda o los filtros aplicados."
      />
    );
  }

  return (
    <EmptyState
      icon={UserRoundX}
      title="Todavía no hay usuarios"
      description="Creá la primera cuenta desde el formulario de arriba."
    />
  );
}

// Listado de usuarios. Mobile-first (tarjetas) y, desde 1.400 px, tabla compacta
// para escanear. Acciones grandes y tocables para el gerente.
export function UserList({
  items,
  nextCursor,
  filters,
  currentUserRole,
  currentUserId,
  showArchived,
}: UserListProps) {
  const isSuperAdmin = currentUserRole === "SUPERADMIN";

  if (items.length === 0) {
    return (
      <Card>
        <VaciaPorque filters={filters} />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* La tabla necesita al menos 1.080 px útiles. Con el sidebar y el padding
          del shell, a 1.280 px solo quedan 960 px: ahí se conservan las tarjetas
          para que ninguna acción dependa de un scroll lateral oculto. */}
      <div className="space-y-3 min-[1400px]:hidden">
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
                  <p className="break-words font-semibold text-text">{user.name}</p>
                  <p className="break-words text-sm text-muted-foreground">
                    <span className="break-all">{user.email}</span>
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {roleBadge(user.role)}
                  {isArchived ? archivedBadge() : statusBadge(user.active)}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                {!isArchived && canManage ? (
                  <Link prefetch={false}
                    href={`/admin/${user.id}`}
                    className={cn(ACCION_TACTIL, "text-sm")}
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

      {/* Escritorios con ancho útil suficiente: tabla compacta. Las acciones
          envuelven y el correo puede cortarse para tolerar contenido largo. */}
      <Card className="hidden overflow-x-auto p-0 min-[1400px]:block">
        <table className="w-full text-left text-sm">
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
                    <span className="break-all">{user.email}</span>
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
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {canManage ? (
                          <Link prefetch={false}
                            href={`/admin/${user.id}`}
                            className={ACCION_TACTIL}
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
          <Link prefetch={false}
            href={adminPageHref(filters, { cursor: nextCursor })}
            className={cn(ACCION_TACTIL, "text-sm")}
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}
