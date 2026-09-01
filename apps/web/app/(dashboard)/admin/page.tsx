import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { isUserManager } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { parseUserFilters } from "@/features/admin/filters";
import { UserFilters } from "@/features/admin/user-filters";
import { UserCreatePanel } from "@/features/admin/user-create-panel";
import { UserList } from "@/features/admin/user-list";
import { getUsers } from "@/server/services/user.service";

export const metadata: Metadata = { title: "Administración" };

// Datos reales en vivo: nunca cachear.
export const dynamic = "force-dynamic";

// --------------------------------------------------------------------------
// Administración de usuarios. Es una HERRAMIENTA, no un panel.
//
// Antes esta pantalla explicaba la jerarquía de roles y las reglas del sistema
// en tarjetas que ocupaban el primer scroll entero. Eso se lee una vez y
// después estorba todos los días: quien entra acá viene a encontrar a una
// persona y hacer algo con ella. Ahora lo primero que se ve es la búsqueda.
//
// VER la lista exige `canManageUsers`; el nav ya oculta el link a los demás
// roles y este guard protege el acceso directo a la ruta. Las MUTACIONES
// conservan sus listas de rol explícitas en las Server Actions: el techo de
// rango es su dominio, no una capability.
// --------------------------------------------------------------------------
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("canManageUsers");

  // Los parámetros se interpretan en UN solo lugar. Lo inválido se descarta y
  // cae al valor por defecto: una URL escrita a mano nunca rompe la pantalla.
  const requested = parseUserFilters(await searchParams);
  const isSuperAdmin = session.user.role === "SUPERADMIN";
  // La vista de archivados sigue siendo de SUPERADMIN. Quien no lo sea y
  // escriba `archived=true` a mano ve la operativa, no un error — y los
  // archivados NO se consultan, así que no hay nada que exponer.
  const filters = { ...requested, archived: isSuperAdmin && requested.archived };
  const showArchived = filters.archived;
  const canCreate = isUserManager(session.user.role);

  const { items, nextCursor } = await getUsers(filters);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Administración"
        description={
          showArchived
            ? "Usuarios archivados: conservan su historial y pueden restaurarse."
            : "Buscá una persona y gestioná su acceso."
        }
      />

      <UserFilters filters={filters} canSeeArchived={isSuperAdmin} />

      {/* El alta no aparece en la vista archivada: ahí no se crea a nadie. Y va
          detrás de una acción: desplegada tapaba la lista entera en un
          teléfono. */}
      {canCreate && !showArchived ? (
        <UserCreatePanel actorRole={session.user.role} />
      ) : null}

      <section aria-labelledby="user-management-title" className="space-y-3">
        <h2 id="user-management-title" className="sr-only">
          {showArchived ? "Usuarios archivados" : "Usuarios"}
        </h2>

        <UserList
          items={items}
          nextCursor={nextCursor}
          filters={filters}
          currentUserRole={session.user.role}
          currentUserId={session.user.id}
          showArchived={showArchived}
        />
      </section>
    </div>
  );
}
