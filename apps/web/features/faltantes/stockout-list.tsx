import Link from "next/link";

import { Card, CardTitle } from "@/app/_components/ui/card";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { StockoutProduct } from "@/server/services/stockout.service";

// --------------------------------------------------------------------------
// "Sin stock, con clientes esperando": lo primero que bodega tiene que mirar.
//
// No es la cola de recepción —ahí ya hay una orden puesta y una caja en
// camino—. Acá todavía no hay orden: son productos que la droguería SÍ lleva y
// que hoy no alcanzan para cubrir lo prometido.
//
// El gesto que se le pide a bodega es BUSCAR EN EL DEPÓSITO antes de que
// gerencia compre: la caja puede estar recibida y sin cargar, o cargada a otro
// producto. Por eso cada fila enlaza a registrar la entrada de ESE producto,
// con la identidad ya decidida.
//
// Si no hay nada, no se pinta NADA. Un bloque vacío permanente arriba de la
// cola de trabajo es peso muerto en el celular de quien está de pie con una
// caja en la mano.
// --------------------------------------------------------------------------

export function StockoutList({ items }: { items: StockoutProduct[] }) {
  if (items.length === 0) return null;

  return (
    <Card className="space-y-3 border-danger/30 p-3">
      <CardTitle>Sin stock, con clientes esperando</CardTitle>
      <p className="text-sm text-muted-foreground">
        Productos que sí llevamos y hoy no alcanzan. Antes de pedirlos, revisá
        el depósito: puede haber llegado algo sin cargar.
      </p>

      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.productId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2"
          >
            <div className="min-w-0">
              <p className="break-words font-semibold text-text">{item.productName}</p>
              <p className="text-xs text-muted-foreground">
                {/* Sin SKU no se puede registrar la entrada. Decirlo acá evita
                    que bodega lo descubra recién al intentarlo. */}
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
                {" · "}
                {/* Cuántas personas esperan, JAMÁS quiénes. Bodega prioriza la
                    búsqueda con el número; la identidad del cliente no le hace
                    falta y no sale de la base. */}
                {item.waitingCount === 1
                  ? "1 cliente esperando"
                  : `${item.waitingCount} clientes esperando`}
                {" · desde "}
                {formatBogotaDate(item.oldestSince, { style: "date" })}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <p className="text-lg font-bold tabular-nums text-danger">
                {item.missingQuantity}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {item.unit}
                </span>
              </p>
              <Link
                prefetch={false}
                href={`/entradas?productId=${item.productId}`}
                className="inline-flex min-h-11 items-center rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground"
              >
                Registrar entrada
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
