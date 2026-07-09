import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { requireCapability } from "@/lib/auth/require-role";
import { AdminOverview } from "@/features/admin/admin-overview";
import { UserForm } from "@/features/admin/user-form";
import { UserList } from "@/features/admin/user-list";
import { getUsers } from "@/server/services/user.service";

export const metadata: Metadata = { title: "Administración" };

// Datos reales en vivo: nunca cachear.
export const dynamic = "force-dynamic";

// Módulo sensible: VER la lista requiere la capability canManageUsers. El nav ya
// oculta el link a otros roles; este guard protege el acceso directo a la ruta
// (sin la capability va a su home). Las MUTACIONES (crear/editar/etc.) conservan
// sus listas de rol explícitas en las Server Actions: el techo de rango es su
// dominio, no una capability.
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; archived?: string }>;
}) {
  const session = await requireCapability("canManageUsers");

  const { cursor, archived } = await searchParams;
  const isSuperAdmin = session.user.role === "SUPERADMIN";
  const showArchived = isSuperAdmin && archived === "true";

  const { items, nextCursor } = await getUsers({
    cursor,
    includeArchived: showArchived,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Administración"
        description="Gestioná usuarios, roles y accesos del equipo desde un centro de control protegido."
      />

      <AdminOverview items={items} showArchived={showArchived} />

      {/* Toggle "Ver archivados / Ver activos" — solo SUPERADMIN. */}
      {isSuperAdmin ? (
        <div className="flex items-center gap-3">
          {showArchived ? (
            <Link
              href="/admin"
              className="text-sm font-semibold text-primary hover:underline"
            >
              ← Ver activos
            </Link>
          ) : (
            <Link
              href="/admin?archived=true"
              className="text-sm font-semibold text-muted-foreground hover:underline"
            >
              Ver archivados
            </Link>
          )}
        </div>
      ) : null}

      {!showArchived ? (
        <Card id="usuarios-y-roles" className="space-y-4">
          <div>
            <CardTitle>Nuevo usuario</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Creá cuentas con el rol permitido por tu jerarquía actual.
            </p>
          </div>
          <UserForm actorRole={session.user.role} />
        </Card>
      ) : null}

      <section
        id="gestion-de-usuarios"
        className="space-y-3"
        aria-labelledby="user-management-title"
      >
        <div>
          <h2 id="user-management-title" className="text-xl font-bold text-text">
            Gestión de usuarios
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Listado operativo con edición, activación, archivo y restauración según permisos vigentes.
          </p>
        </div>

        <UserList
          items={items}
          nextCursor={nextCursor}
          currentUserRole={session.user.role}
          currentUserId={session.user.id}
          showArchived={showArchived}
        />
      </section>
    </div>
  );
}
