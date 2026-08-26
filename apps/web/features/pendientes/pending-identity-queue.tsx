import Link from "next/link";
import { ScanBarcode } from "lucide-react";

import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import type { PendingIdentityQueueRow } from "@/server/repositories/pending.repository";

type PendingIdentityQueueProps = {
  items: readonly PendingIdentityQueueRow[];
  nextCursor: string | null;
  /** El enlace lo arma la página, que es la que conoce su propia ruta. */
  pageHref: (nextCursor: string) => string;
};

// --------------------------------------------------------------------------
// La cola de productos que todavía esperan su código de Orion (S2b · 2-B1).
//
// Presentacional y nada más. NO ordena, NO agrupa, NO cuenta y NO recorta:
// todo eso llega resuelto desde `listPendingIdentityQueue`, que agrupa por
// producto y ordena por cantidad DESC. Reordenar acá sería una segunda opinión
// sobre la prioridad, y el día que una de las dos cambie la pantalla mostraría
// un orden distinto del que dice el contrato.
//
// Tampoco decide QUIÉN ve qué. El alcance —cola entera o solo lo propio— ya lo
// aplicó el servicio con la matriz de capacidades. Acá no hay ni un rol.
//
// El cursor viaja OPACO: entra como string y sale como string. Ni se parsea ni
// se compara; si la UI lo interpretara, quedaría atada al codificador del
// repositorio y se rompería en silencio al cambiarlo.
// --------------------------------------------------------------------------
export function PendingIdentityQueue({
  items,
  nextCursor,
  pageHref,
}: PendingIdentityQueueProps) {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={ScanBarcode}
          title="Sin identidades pendientes"
          description="Todos los productos con pendientes abiertos ya tienen su código de Orion."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[24rem] text-left text-sm">
          {/* La tabla se anuncia sola con lector de pantalla: sin esto, quien
              la escucha entra a una grilla de números sin saber qué cuenta. */}
          <caption className="sr-only">
            Productos sin código de Orion, del que más pendientes acumula al que
            menos.
          </caption>
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Producto
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Código interno
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Pendientes
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.productId} className="border-b border-border last:border-0">
                <td className="px-4 py-3 font-medium text-text">{item.productName}</td>
                <td className="break-words px-4 py-3 font-mono text-xs text-muted-foreground">
                  {item.productCode}
                </td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums text-text">
                  {item.pendingCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link
            href={pageHref(nextCursor)}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}
