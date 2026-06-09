import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { requireActiveRole } from "@/lib/auth/require-role";
import { UserEditForm } from "@/features/admin/user-edit-form";
import { getUserById } from "@/server/services/user.service";

export const metadata: Metadata = { title: "Editar usuario" };

export const dynamic = "force-dynamic";

export default async function AdminUserEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireActiveRole("ADMIN");

  const { id } = await params;
  const user = await getUserById(id);
  if (!user) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Editar usuario"
        description="Actualizá el nombre, el email o el rol. La contraseña no se cambia desde acá."
      />

      <Link
        href="/admin"
        className="inline-block text-sm font-semibold text-primary hover:underline"
      >
        ← Volver a usuarios
      </Link>

      <Card className="space-y-4">
        <CardTitle>{user.name}</CardTitle>
        <UserEditForm
          user={{
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
          }}
        />
      </Card>
    </div>
  );
}
