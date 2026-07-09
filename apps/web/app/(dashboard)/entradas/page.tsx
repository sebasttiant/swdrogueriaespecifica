import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { MAX_PAGE_SIZE } from "@/lib/pagination";
import { requireCapability } from "@/lib/auth/require-role";
import { EntryForm, type ProductOption } from "@/features/entradas/entry-form";
import { EntryList } from "@/features/entradas/entry-list";
import { getProducts } from "@/server/services/product.service";
import { getInventoryEntries } from "@/server/services/inventory-entry.service";

export const metadata: Metadata = { title: "Entradas" };

export default async function EntradasPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  await requireCapability("canViewEntradas");

  const { cursor } = await searchParams;

  // Opciones para el selector del formulario: primera página de productos activos.
  const [products, entries] = await Promise.all([
    getProducts({ take: MAX_PAGE_SIZE }),
    getInventoryEntries({ cursor }),
  ]);

  const productOptions: ProductOption[] = products.items
    .filter((product) => product.active)
    .map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
    }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Entradas de inventario"
        description="Registrá una recepción de stock para actualizar el inventario."
      />

      <Card className="space-y-4">
        <CardTitle>Nueva entrada</CardTitle>
        <EntryForm products={productOptions} />
      </Card>

      <EntryList items={entries.items} nextCursor={entries.nextCursor} />
    </div>
  );
}
