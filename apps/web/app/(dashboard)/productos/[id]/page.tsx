import { notFound } from "next/navigation";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { BatchList } from "@/features/productos/batch-list";
import { OrionLinkForm } from "@/features/productos/orion-link-form";
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

      {/* Identidad del producto. Se muestra SIEMPRE, tenga código o no: que un
          producto no esté vinculado es justamente lo que hay que poder ver de
          un vistazo, y esconder la tarjeta cuando falta el dato es esconder el
          trabajo pendiente. */}
      <Card className="space-y-3">
        <CardTitle>Identidad</CardTitle>
        {product.orionCode ? (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Código de Orion</p>
            <p className="font-mono text-lg font-medium text-text">
              {product.orionCode}
            </p>
            <p className="text-xs text-muted-foreground">
              Vinculado. Este código no se cambia desde acá.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Este producto todavía no tiene su código de Orion. Sin él no se
              puede cuadrar el inventario.
            </p>
            {can(session.user.role, "canManageProducts") ? (
              <OrionLinkForm
                productId={product.id}
                identityVersion={product.identityVersion}
              />
            ) : null}
          </div>
        )}
        {product.internalSku ? (
          <p className="text-xs text-muted-foreground">
            Código interno: <span className="font-mono">{product.internalSku}</span>
          </p>
        ) : null}
      </Card>

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
