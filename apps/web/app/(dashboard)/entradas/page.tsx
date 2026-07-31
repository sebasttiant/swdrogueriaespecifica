import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { MAX_PAGE_SIZE } from "@/lib/pagination";
import { requireCapability } from "@/lib/auth/require-role";
import { EntryForm, type ProductOption } from "@/features/entradas/entry-form";
import { EntryList } from "@/features/entradas/entry-list";
import { ArrivedMissingQueue } from "@/features/entradas/arrived-missing-queue";
import { getProducts } from "@/server/services/product.service";
import { getArrivedMissingItems, getInventoryEntries } from "@/server/services/inventory-entry.service";

export const metadata: Metadata = { title: "Entradas" };

export default async function EntradasPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; productId?: string; quantity?: string }>;
}) {
  await requireCapability("canViewEntradas");

  const { cursor, productId, quantity } = await searchParams;

  // La cola de bodega propone la cantidad. Solo se acepta un entero positivo:
  // cualquier otra cosa en la URL se ignora y el formulario vuelve a su default.
  const parsedQuantity = Number(quantity);
  const suggestedQuantity =
    Number.isInteger(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : undefined;

  // Opciones para el selector del formulario: primera página de productos activos.
  const [products, entries, arrivedItems] = await Promise.all([
    getProducts({ take: MAX_PAGE_SIZE }),
    getInventoryEntries({ cursor }),
    getArrivedMissingItems(),
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

      <ArrivedMissingQueue items={arrivedItems} />

      <Card id="nueva-entrada" className="scroll-mt-24 space-y-4">
        <CardTitle>Nueva entrada</CardTitle>
        <EntryForm
          products={productOptions}
          selectedProductId={productId}
          selectedQuantity={suggestedQuantity}
        />
      </Card>

      <EntryList items={entries.items} nextCursor={entries.nextCursor} />
    </div>
  );
}
