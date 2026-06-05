import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { getCurrentSession } from "@/lib/auth/index.node";
import { hasRole } from "@/lib/auth/require-role";
import { ProductForm } from "@/features/productos/product-form";
import { ProductList } from "@/features/productos/product-list";
import { getProducts } from "@/server/services/product.service";

export const metadata: Metadata = { title: "Productos" };

export default async function ProductosPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const session = await getCurrentSession();
  const canManage = session
    ? hasRole(session.user.role, ["ADMIN", "LIDER"])
    : false;

  const { items, nextCursor } = await getProducts({ cursor });

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

      <ProductList items={items} nextCursor={nextCursor} />
    </div>
  );
}
