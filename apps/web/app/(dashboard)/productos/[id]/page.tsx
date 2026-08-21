import { notFound } from "next/navigation";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { BatchList } from "@/features/productos/batch-list";
import { ProductIdentityCard } from "@/features/productos/product-identity-card";
import {
  getBatchesByProduct,
  getSellableStock,
} from "@/server/services/product-batch.service";
import { getProduct } from "@/server/services/product.service";

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await requireCapability("canViewProductos");

  const { id } = await params;
  const { cursor } = await searchParams;

  const product = await getProduct(id);
  if (!product) notFound();

  const [stock, batches] = await Promise.all([
    getSellableStock(id),
    getBatchesByProduct({ productId: id, cursor }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={product.name}
        description={`${product.code} · ${product.unit}`}
      />

      <Card className="space-y-1">
        <CardTitle>Stock vendible</CardTitle>
        <p className="text-2xl font-bold text-text">
          {stock} <span className="text-base font-normal">{product.unit}</span>
        </p>
        <p className="text-sm text-muted-foreground">
          Suma de lotes disponibles, con stock y no vencidos.
        </p>
      </Card>

      <ProductIdentityCard
        productId={product.id}
        orionCode={product.orionCode}
        internalSku={product.internalSku}
        identityVersion={product.identityVersion}
        canLink={can(session.user.role, "canManageProducts")}
        canFix={can(session.user.role, "canFixProductIdentity")}
      />

      <div className="space-y-3">
        <CardTitle>Lotes</CardTitle>
        <BatchList
          productId={id}
          items={batches.items}
          nextCursor={batches.nextCursor}
        />
      </div>
    </div>
  );
}
