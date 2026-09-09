import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { MAX_PAGE_SIZE } from "@/lib/pagination";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { EntryForm, type ProductOption } from "@/features/entradas/entry-form";
import { EntryList } from "@/features/entradas/entry-list";
import { ArrivedMissingQueue } from "@/features/entradas/arrived-missing-queue";
import {
  getProducts,
  getEntryProduct,
} from "@/server/services/product.service";
import {
  getArrivedMissingItems,
  getInventoryEntries,
} from "@/server/services/inventory-entry.service";

export const metadata: Metadata = { title: "Entradas" };

export default async function EntradasPage({
  searchParams,
}: {
  searchParams: Promise<{
    cursor?: string;
    productId?: string;
    quantity?: string;
    // Presente cuando la entrada sale de la cola de bodega: ahí el producto ya
    // está decidido por el faltante y no se vuelve a elegir.
    missingItemId?: string;
  }>;
}) {
  const session = await requireCapability("canViewEntradas");
  // El circuito de recepción (form de nueva entrada + cola de bodega) es de
  // gerencia y bodega: OPERADOR y SUPERVISOR ven la lista pero no registran.
  const canCreate = can(session.user.role, "canCreateEntries");

  const { cursor, productId, quantity, missingItemId } = await searchParams;

  // La cola de bodega propone la cantidad. Solo se acepta un entero positivo:
  // cualquier otra cosa en la URL se ignora y el formulario vuelve a su default.
  const parsedQuantity = Number(quantity);
  const suggestedQuantity =
    Number.isInteger(parsedQuantity) && parsedQuantity > 0
      ? parsedQuantity
      : undefined;

  // Opciones para el selector del formulario: primera página de productos activos.
  const [products, entries, arrivedItems, selectedProduct] = await Promise.all([
    getProducts({ take: MAX_PAGE_SIZE, active: true }),
    getInventoryEntries({ cursor }),
    getArrivedMissingItems(),
    canCreate && productId ? getEntryProduct(productId) : null,
  ]);

  const productOptions: ProductOption[] = products.items
    .filter((product) => product.active)
    .map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
      orionCode: product.orionCode,
      laboratoryName: product.laboratory?.name ?? null,
      unit: product.unit,
      // Las dos versiones viajan a la pantalla para que el formulario pueda
      // declarar contra qué fotografía se registró la entrada.
      identityVersion: product.identityVersion,
      catalogVersion: product.catalogVersion,
    }));

  // La URL se resuelve independientemente de la página, sin duplicar identidades.
  const options = selectedProduct
    ? [
        selectedProduct,
        ...productOptions.filter((option) => option.id !== selectedProduct.id),
      ]
    : productOptions;
  const lockedProduct = missingItemId
    ? (selectedProduct ?? undefined)
    : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Entradas de inventario"
        description="Registrá una recepción de stock para actualizar el inventario."
      />

      {canCreate ? <ArrivedMissingQueue items={arrivedItems} /> : null}

      {canCreate ? (
        <Card id="nueva-entrada" className="scroll-mt-24 space-y-4">
          <CardTitle>Nueva entrada</CardTitle>
          {/* `key` fuerza a REMONTAR el formulario cuando cambia el producto que
              se viene a cargar.
              Sin esto, tocar "Cargar entrada" navegaba a la MISMA ruta con otros
              parámetros: React reconciliaba en vez de remontar, y el `defaultValue`
              del selector —que solo se aplica al montar— quedaba ignorado. El
              producto viajaba en la URL y el campo se veía vacío igual. */}
          <EntryForm
            key={`${productId ?? "sin-producto"}:${suggestedQuantity ?? 0}:${missingItemId ?? "sin-faltante"}`}
            products={options}
            selectedProductId={selectedProduct?.id}
            selectedQuantity={suggestedQuantity}
            lockedProduct={lockedProduct}
            missingItemId={lockedProduct ? missingItemId : undefined}
          />
        </Card>
      ) : null}

      <EntryList items={entries.items} nextCursor={entries.nextCursor} />
    </div>
  );
}
