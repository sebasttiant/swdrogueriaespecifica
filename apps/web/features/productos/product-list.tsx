import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import type { ProductListItem } from "@/server/repositories/product.repository";

type ProductListProps = {
  items: ProductListItem[];
  nextCursor: string | null;
};

// Listado presentacional (server component). Mobile-first: tarjetas apiladas.
export function ProductList({ items, nextCursor }: ProductListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-base text-muted-foreground">
          Todavía no hay productos cargados.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((product) => (
        <Link key={product.id} href={`/productos/${product.id}`} className="block">
          <Card className="flex items-center justify-between gap-3 transition-colors hover:bg-muted/40">
            <div className="min-w-0">
              <p className="truncate font-semibold text-text">{product.name}</p>
              <p className="text-sm text-muted-foreground">
                {product.code} · {product.unit} · stock mín. {product.minStock}
              </p>
            </div>
            <Badge tone={product.active ? "success" : "neutral"}>
              {product.active ? "Activo" : "Inactivo"}
            </Badge>
          </Card>
        </Link>
      ))}

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            href={`/productos?cursor=${encodeURIComponent(nextCursor)}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}
