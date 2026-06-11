import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { expiryLevel, type ExpiryLevel } from "@/lib/inventory/batch-status";
import type { ProductListItem } from "@/server/repositories/product.repository";

type ProductListProps = {
  items: ProductListItem[];
  nextCursor: string | null;
  q?: string;
};

// Spanish labels and tones for each expiry tier.
// Labels and tone map live in the feature layer — lib stays language-free.
const EXPIRY_LABEL: Record<ExpiryLevel, string> = {
  expired: "Vencido",
  critical: "Crítico",
  warning: "Por vencer",
  ok: "Vigente",
};

const EXPIRY_TONE: Record<ExpiryLevel, "danger" | "warning" | "success" | "neutral"> = {
  expired: "danger",
  critical: "danger",
  warning: "warning",
  ok: "success",
};

// Listado presentacional (server component). Mobile-first: tarjetas apiladas.
// S3: shows worst expiry tier badge per product (from worstExpiresAt).
// Only renders the badge when expiry is NOT "ok" — reduces visual noise.
export function ProductList({ items, nextCursor, q }: ProductListProps) {
  const now = new Date();

  if (items.length === 0) {
    const hasQuery = Boolean(q?.trim());
    return (
      <Card>
        <p className="text-base text-muted-foreground">
          {hasQuery
            ? "No hay productos que coincidan con tu búsqueda."
            : "Todavía no hay productos cargados."}
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((product) => {
        const worstLevel = product.worstExpiresAt
          ? expiryLevel(product.worstExpiresAt, now)
          : null;

        return (
          <Link key={product.id} href={`/productos/${product.id}`} className="block">
            <Card className="flex items-center justify-between gap-3 transition-colors hover:bg-muted/40">
              <div className="min-w-0">
                <p className="truncate font-semibold text-text">{product.name}</p>
                <p className="text-sm text-muted-foreground">
                  {product.code} · {product.unit} · stock mín. {product.minStock}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone={product.active ? "success" : "neutral"}>
                  {product.active ? "Activo" : "Inactivo"}
                </Badge>
                {worstLevel && worstLevel !== "ok" ? (
                  <Badge tone={EXPIRY_TONE[worstLevel]}>
                    {EXPIRY_LABEL[worstLevel]}
                  </Badge>
                ) : null}
              </div>
            </Card>
          </Link>
        );
      })}

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            href={`/productos?cursor=${encodeURIComponent(nextCursor)}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}
