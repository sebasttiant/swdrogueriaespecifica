import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { MissingList } from "@/features/faltantes/missing-list";
import { getMissingItems } from "@/server/services/missing-item.service";

export const metadata: Metadata = { title: "Faltantes" };

export default async function FaltantesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const { items, nextCursor } = await getMissingItems({ cursor });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Faltantes"
        description="Lo que hay que conseguir. Se generan automáticamente desde un pendiente sin stock suficiente."
      />

      <MissingList items={items} nextCursor={nextCursor} />
    </div>
  );
}
