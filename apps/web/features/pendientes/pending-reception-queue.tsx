import Link from "next/link";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { ReceiverArrivedButton } from "@/features/faltantes/receiver-arrived-button";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { PendingReceptionItem } from "@/server/services/pending-reception.service";
import { PackageCheck } from "lucide-react";

// --------------------------------------------------------------------------
// LA MESA DE BODEGA PARA LOS PEDIDOS DE CLIENTES.
//
// Vive DENTRO de Revisión de pendientes: un pendiente se completa en un solo
// lugar, y mandar a bodega a otra pantalla para la mitad del trabajo es cómo
// se pierde una llegada.
//
// No hay botón de "Pedido" y no es un olvido: cuando el vendedor registró el
// pendiente, el cliente YA PIDIÓ el producto. Lo que falta no es una decisión
// de compra —esa es otra pregunta, y vive en Seguimiento— sino existencia
// física. Por eso los únicos dos gestos acá son "Ya llegó" y "Registrar
// entrada".
//
// Los datos llegan ya minimizados por el servicio: no hay cliente, ni
// teléfono, ni dirección, ni abonos. Esta pantalla no podría mostrarlos ni
// queriendo.
// --------------------------------------------------------------------------

export function PendingReceptionQueue({
  items,
  canReceive,
}: {
  items: PendingReceptionItem[];
  /** `canReceiveMissingItems`: BODEGA, ADMIN y SUPERADMIN. */
  canReceive: boolean;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={PackageCheck}
          title="No hay nada que recibir"
          description="Cuando un cliente pida algo que no está en inventario, aparece acá."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <Card key={item.id} className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="break-words text-base font-semibold text-text">
                {item.productName}
              </p>
              <p className="text-xs text-muted-foreground">
                {/* Sin SKU no se puede registrar la entrada. Decirlo acá evita
                    que bodega lo descubra recién al intentarlo, y el enlace va
                    al producto EXACTO: la identidad ya la decidió el pendiente,
                    no hay nada que buscar entre nombres casi iguales. */}
                {item.orionCode ? (
                  <span className="font-mono">{item.orionCode}</span>
                ) : (
                  <Link
                    prefetch={false}
                    href={`/productos/${item.productId}`}
                    className="font-semibold text-warning-foreground underline underline-offset-2"
                  >
                    Falta el SKU — completalo
                  </Link>
                )}
                {" · pedido el "}
                {formatBogotaDate(item.requestedAt, { style: "date" })}
              </p>
              {item.laboratoryName || item.requestedLaboratoryName ? (
                <p className="text-xs text-muted-foreground">
                  Laboratorio: {item.laboratoryName ?? item.requestedLaboratoryName}
                </p>
              ) : null}
            </div>

            <div className="text-right">
              <p className="text-lg font-bold tabular-nums text-text">
                {item.outstandingQuantity}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {item.unit} por conseguir
                </span>
              </p>
              {/* Lo ya reservado se muestra aparte: sin ese número, "faltan 6
                  de 10" se lee como si no hubiera llegado nada. */}
              {item.reservedQuantity > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {item.reservedQuantity} de {item.requestedQuantity} ya reservadas
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            {item.hasArrived ? (
              <Badge tone="success">
                Llegó · sin cargar
                {/* Auditoría a la vista: quién la recibió y cuándo. */}
                {item.arrivedByName ? ` · ${item.arrivedByName}` : ""}
                {item.arrivedAt
                  ? ` · ${formatBogotaDate(item.arrivedAt, { style: "datetime" })}`
                  : ""}
              </Badge>
            ) : (
              <Badge tone="warning">Esperando que llegue</Badge>
            )}

            {/* El servidor revalida la misma capability: esconder el control no
                autoriza nada, solo evita ofrecer lo que después se rechaza. */}
            {canReceive ? (
              item.hasArrived ? (
                /* El producto viaja en la URL y queda FIJO del otro lado: la
                   identidad ya la decidió el pendiente, y volver a elegirla
                   reabre el error que este camino cierra. */
                <Link
                  prefetch={false}
                  href={`/entradas?productId=${item.productId}&missingItemId=${item.id}&quantity=${item.outstandingQuantity}`}
                  className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"
                >
                  Registrar entrada
                </Link>
              ) : (
                <ReceiverArrivedButton
                  missingItemId={item.id}
                  productName={item.productName}
                />
              )
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  );
}
