import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { MissingList } from "@/features/faltantes/missing-list";
import { getCurrentSession } from "@/lib/auth/index.node";
import { hasRole } from "@/lib/auth/require-role";
import { getMissingItems } from "@/server/services/missing-item.service";

export const metadata: Metadata = { title: "Faltantes" };

export default async function FaltantesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const session = await getCurrentSession();
  const canConfirm = session
    ? hasRole(session.user.role, ["SUPERADMIN", "ADMIN"])
    : false;
  const { items, nextCursor } = await getMissingItems({ cursor });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Faltantes"
        description="Lo que hay que conseguir. Se generan automáticamente desde un pendiente sin stock suficiente."
      />

      <MissingList items={items} nextCursor={nextCursor} canConfirm={canConfirm} />
    </div>
  );
}
