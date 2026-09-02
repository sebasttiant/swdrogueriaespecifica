import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { ProductForm } from "@/features/productos/product-form";
import { ProductList } from "@/features/productos/product-list";
import { getProducts } from "@/server/services/product.service";

export const metadata: Metadata = { title: "Productos" };

export default async function ProductosPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; q?: string }>;
}) {
  const { cursor, q } = await searchParams;
  const session = await requireCapability("canViewProductos");
  const canManage = can(session.user.role, "canManageProducts");

  const { items, nextCursor } = await getProducts({ cursor, q });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Productos"
        description="Catálogo maestro de la droguería."
      />

      {canManage ? (
        <Card className="space-y-4">
          <CardTitle>Nuevo producto</CardTitle>
          <ProductForm />
        </Card>
      ) : null}

      <ProductList items={items} nextCursor={nextCursor} q={q} />
    </div>
  );
}
