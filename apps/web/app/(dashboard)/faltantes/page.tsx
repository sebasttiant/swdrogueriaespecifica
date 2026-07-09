import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { MissingList } from "@/features/faltantes/missing-list";
import { MissingSummary } from "@/features/faltantes/missing-summary";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import {
  getMissingItems,
  getMissingItemsSummary,
} from "@/server/services/missing-item.service";

export const metadata: Metadata = { title: "Faltantes" };

export default async function FaltantesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const session = await requireCapability("canViewFaltantes");
  const canConfirm = can(session.user.role, "canConfirmMissingItems");
  const canViewCustomerIdentity = can(session.user.role, "canViewCustomerIdentity");

  // Un único instante compartido por el resumen global y el agrupamiento de
  // la página actual, para que ambos hablen del mismo "ahora".
  const now = new Date();
  const [{ items, nextCursor }, summary] = await Promise.all([
    getMissingItems({ cursor, canViewCustomerIdentity }),
    getMissingItemsSummary(now),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Faltantes"
        description="Lo que hay que conseguir. Se generan automáticamente desde un pendiente sin stock suficiente."
      />

      <MissingSummary summary={summary} />

      <MissingList
        items={items}
        nextCursor={nextCursor}
        canConfirm={canConfirm}
        now={now}
      />
    </div>
  );
}
