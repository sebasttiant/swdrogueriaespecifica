import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { requireActiveRole } from "@/lib/auth/require-role";
import { UserForm } from "@/features/admin/user-form";
import { UserList } from "@/features/admin/user-list";
import { getUsers } from "@/server/services/user.service";

export const metadata: Metadata = { title: "Usuarios" };

// Datos reales en vivo: nunca cachear.
export const dynamic = "force-dynamic";

// Módulo sensible: solo ADMIN. El nav ya oculta el link a otros roles; este
// guard protege el acceso directo a la ruta (un no-admin va a su home).
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  await requireActiveRole("ADMIN");

  const { cursor } = await searchParams;
  const { items, nextCursor } = await getUsers({ cursor });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usuarios"
        description="Creá y administrá las cuentas del equipo. Para quitar acceso, desactivá la cuenta (no se borra)."
      />

      <Card className="space-y-4">
        <CardTitle>Nuevo usuario</CardTitle>
        <UserForm />
      </Card>

      <UserList items={items} nextCursor={nextCursor} />
    </div>
  );
}
