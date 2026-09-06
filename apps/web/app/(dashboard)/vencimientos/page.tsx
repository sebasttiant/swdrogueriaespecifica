import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { requireCapability } from "@/lib/auth/require-role";
import { EXPIRY_TIERS } from "@/lib/inventory/batch-status";
import { cn } from "@/lib/utils/cn";
import {
  EXPIRY_TIER_DESCRIPTIONS,
  EXPIRY_TIER_LABELS,
  resolveExpiryTier,
  vencimientosHref,
} from "@/features/vencimientos/expiry-tier";
import { ExpiringBatchList } from "@/features/vencimientos/expiring-batch-list";
import {
  getExpiringBatchCounts,
  getExpiringBatches,
} from "@/server/services/product-batch.service";

export const metadata: Metadata = { title: "Vencimientos" };

// --------------------------------------------------------------------------
// Vencimientos — la pantalla que abren los chips de la barra de alertas.
//
// Es de LECTURA. No lleva formulario de alta a propósito: el chip dice "hay 3
// lotes vencidos" y quien lo toca quiere ver CUÁLES son, no crear un producto.
// Ese era el defecto viejo — el chip caía en `/productos`, que empieza con el
// formulario de "Nuevo producto" y sigue con el catálogo entero sin filtrar.
//
// Las tres franjas conviven como pestañas para que se pueda pasar de "vencidos"
// a "vence dentro de tres meses" sin volver atrás: es la misma pregunta mirada
// a distintas distancias.
// --------------------------------------------------------------------------
export default async function VencimientosPage({
  searchParams,
}: {
  searchParams: Promise<{ tier?: string; cursor?: string }>;
}) {
  // Misma capacidad que el catálogo: quien puede ver los productos puede ver
  // sus lotes. Una capacidad propia sería una segunda matriz de permisos, y el
  // día que se separen el menú mostraría un link que termina en redirect.
  await requireCapability("canViewProductos");

  const { tier: rawTier, cursor } = await searchParams;
  const tier = resolveExpiryTier(rawTier);

  // UN SOLO "ahora" para los contadores de las pestañas y para la lista. Con
  // dos relojes distintos, un lote que cruza la medianoche de Bogotá entre una
  // consulta y la otra haría que la pestaña dijera 3 y la tabla mostrara 4.
  const now = new Date();

  const [counts, batches] = await Promise.all([
    getExpiringBatchCounts(now),
    getExpiringBatches({ tier, cursor, now }),
  ]);

  const countOf = {
    expired: counts.expired,
    critical: counts.critical,
    warning: counts.warning,
  } as const;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vencimientos"
        description="Lotes con existencias, ordenados por el que vence antes."
      />

      <nav
        aria-label="Franja de vencimiento"
        className="flex flex-wrap gap-2 text-sm font-semibold"
      >
        {EXPIRY_TIERS.map((candidate) => (
          <Link
            prefetch={false}
            key={candidate}
            href={vencimientosHref({ tier: candidate })}
            aria-current={candidate === tier ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-lg px-3 py-1.5 transition-colors",
              candidate === tier
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            <span>{EXPIRY_TIER_LABELS[candidate]}</span>
            <span>{countOf[candidate]}</span>
          </Link>
        ))}
      </nav>

      <p className="text-sm text-muted-foreground">
        {EXPIRY_TIER_DESCRIPTIONS[tier]}
      </p>

      <ExpiringBatchList
        tier={tier}
        items={batches.items}
        nextCursor={batches.nextCursor}
        now={now}
      />
    </div>
  );
}
