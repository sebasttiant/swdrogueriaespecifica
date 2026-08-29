import Link from "next/link";

import { Card } from "@/app/_components/ui/card";
import { ReceiverArrivedButton } from "./receiver-arrived-button";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { PackageCheck } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { ReceiverItem, ReceiverScope } from "@/server/services/missing-receiver.service";

// --------------------------------------------------------------------------
// La cola de bodega: lo que hay que recibir.
//
// UNA SOLA COLA, con los dos orígenes juntos. Bodega recibe CAJAS: no clasifica
// de dónde nació la demanda. Partírsela en dos pantallas —una por pedidos de
// cliente y otra por reposición— le pediría separar algo que no le importa, y
// es exactamente así como un día se pasa una llegada. Gerencia mira por origen
// porque decide qué comprar; bodega mira por bulto físico.
//
// DOS pestañas y ninguna más. "Por pedir" y "Descartados" no se ocultan por
// estética: quien recibe no decide qué se compra, y ver la cola de compras
// invita a marcar llegadas sobre mercadería que nadie pidió.
//
// Los datos que llegan acá ya vienen minimizados por el servidor. Esta pantalla
// no tiene forma de mostrar el cliente aunque quisiera.
// --------------------------------------------------------------------------

/** Dónde vive la cola de bodega. Su propia ruta, no una pestaña de otro módulo. */
export const RECEPTION_PATH = "/recepcion";

const TABS: { scope: ReceiverScope; label: string; href: string }[] = [
  { scope: "PEDIDO", label: "Por recibir", href: RECEPTION_PATH },
  { scope: "EN_BODEGA", label: "En bodega", href: `${RECEPTION_PATH}?scope=arrived` },
];

const EMPTY: Record<ReceiverScope, { title: string; description: string }> = {
  PEDIDO: {
    title: "No hay nada esperando",
    description:
      "Cuando gerencia pida algo —para un cliente o para la estantería— aparece acá para recibirlo.",
  },
  EN_BODEGA: {
    title: "Nada llegó todavía",
    description: "Lo que marques como llegado aparece acá hasta que registres la entrada.",
  },
};

export function ReceiverQueue({
  items,
  scope,
}: {
  items: ReceiverItem[];
  scope: ReceiverScope;
}) {
  return (
    <div className="space-y-4">
      <nav aria-label="Estado de la recepción" className="flex gap-2 text-sm font-semibold">
        {TABS.map((tab) => (
          <Link
            prefetch={false}
            key={tab.scope}
            href={tab.href}
            aria-current={scope === tab.scope ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 transition-colors",
              scope === tab.scope
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={PackageCheck}
            title={EMPTY[scope].title}
            description={EMPTY[scope].description}
          />
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Producto</th>
                <th className="px-3 py-2 font-medium">Para</th>
                <th className="px-3 py-2 font-medium">SKU (código de Orion)</th>
                <th className="px-3 py-2 font-medium">Laboratorio</th>
                <th className="px-3 py-2 font-medium">Falta recibir</th>
                <th className="px-3 py-2 font-medium">Acción</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-medium text-text">{item.productName}</td>
                  {/* Para QUÉ es esta caja. CATEGORÍA, nunca el nombre del
                      cliente: el `select` del servicio ni siquiera lo trae, y
                      mandarlo para que la pantalla lo escondiera sería mandarlo
                      igual. Bodega necesita saber que hay alguien esperando
                      —para priorizar la descarga—, no quién es. */}
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold",
                        item.originId
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-border bg-muted/40 text-muted-foreground",
                      )}
                    >
                      {item.originId ? "Cliente" : "Estantería"}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {/* Sin SKU no se puede registrar la entrada. Decirlo acá
                        evita que bodega lo descubra recién al intentarlo. */}
                    {item.orionCode ?? (
                      /* Enlaza al producto EXACTO. El mensaje "completalo en
                         Productos" obligaba a buscarlo a mano entre nombres
                         casi idénticos — el mismo problema que hizo elegir el
                         equivocado al registrar la entrada. Acá el id ya está
                         decidido por el faltante: no hay nada que buscar. */
                      <Link
                        prefetch={false}
                        href={`/productos/${item.productId}`}
                        className="font-sans font-semibold text-warning-foreground underline underline-offset-2"
                      >
                        Falta el SKU — completalo
                      </Link>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {item.laboratoryName ?? item.requestedLaboratoryName ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-bold tabular-nums text-text">
                    {item.outstandingQuantity}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {item.unit}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {scope === "EN_BODEGA" ? (
                      /* El producto viaja en la URL y queda FIJO del otro lado.
                         Esa es la diferencia con entrar a Entradas y buscarlo:
                         acá la identidad ya la decidió el faltante, y volver a
                         elegirla reabre el error que este camino cierra. */
                      <Link
                        prefetch={false}
                        href={`/entradas?productId=${item.productId}&missingItemId=${item.id}&quantity=${item.outstandingQuantity}`}
                        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                      >
                        Registrar entrada
                      </Link>
                    ) : (
                      /* Acá se cortaba la cadena. La columna decía "Esperando
                         que llegue" y no ofrecía nada, así que nada movía un
                         faltante a EN_BODEGA: la pestaña de al lado quedaba
                         siempre vacía y "Registrar entrada" —que solo se pinta
                         ahí— era inalcanzable. Bodega recibía la caja y no
                         tenía dónde decirlo. */
                      <ReceiverArrivedButton
                        missingItemId={item.id}
                        productName={item.productName}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
