import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { expiryLevel, isAgotado, type ExpiryLevel } from "@/lib/inventory/batch-status";
import type { BatchListItem } from "@/server/repositories/product-batch.repository";

import { batchCodeTitle, batchExpiryTitle } from "./batch-labels";

type BatchListProps = {
  productId: string;
  items: BatchListItem[];
  nextCursor: string | null;
};

// 5-tier label/tone maps. Both expired and critical map to "danger" tone.
// Labels live in the feature layer — lib stays language-free.
//
// `unknown` es el lote sin fecha de vencimiento: tono neutro porque no hay nada
// que avisar, y NO "danger", que lo haría parecer vencido. La insignia es el
// único lugar donde se dice, así que la línea de datos omite el "Vence:" en vez
// de repetirlo.
const EXPIRY_TONE: Record<ExpiryLevel, "danger" | "warning" | "success" | "neutral"> = {
  expired: "danger",
  critical: "danger",
  warning: "warning",
  ok: "success",
  unknown: "neutral",
};

const EXPIRY_LABEL: Record<ExpiryLevel, string> = {
  expired: "Vencido",
  critical: "Crítico",
  warning: "Por vencer",
  ok: "Vigente",
  unknown: "Sin vencimiento",
};

// Listado de lotes con semáforo de vencimiento DERIVADO en lectura.
// S3: supports 5 tiers (expired / critical / warning / ok / unknown) with
// calendar-day Bogota semantics. El lote y la fecha se leen a través de
// `batch-labels`, que traduce el código reservado a "Sin lote".
export function BatchList({ productId, items, nextCursor }: BatchListProps) {
  const now = new Date();

  if (items.length === 0) {
    return (
      <Card>
        <p className="text-base text-muted-foreground">
          Este producto todavía no tiene lotes cargados.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((batch) => {
        const level = expiryLevel(batch.expiresAt, now);
        return (
          <Card key={batch.id} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="break-words font-semibold text-text">
                {batchCodeTitle(batch.batchCode)}
              </p>
              <Badge tone={EXPIRY_TONE[level]}>{EXPIRY_LABEL[level]}</Badge>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {/* Sin fecha no se escribe "Vence:": la insignia ya dice "Sin
                  vencimiento" y repetirlo agrega un dato que no existe. */}
              {batch.expiresAt ? (
                <span>{batchExpiryTitle(batch.expiresAt)}</span>
              ) : null}
              <span>Cantidad: {batch.quantity}</span>
              {batch.location ? <span>Ubicación: {batch.location}</span> : null}
              <span>Estado: {batch.status}</span>
              {isAgotado(batch.quantity) ? (
                <span className="font-medium text-danger">Agotado</span>
              ) : null}
            </div>
          </Card>
        );
      })}

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link prefetch={false}
            href={`/productos/${productId}?cursor=${encodeURIComponent(nextCursor)}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}
