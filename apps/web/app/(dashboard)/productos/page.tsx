import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { ProductList } from "@/features/productos/product-list";
import { getProducts } from "@/server/services/product.service";

export const metadata: Metadata = { title: "Productos" };

export default async function ProductosPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const { items, nextCursor } = await getProducts({ cursor });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Productos"
        description="Catálogo maestro de la droguería."
      />

      <ProductList items={items} nextCursor={nextCursor} />
    </div>
  );
}
