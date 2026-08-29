import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { ReceiverQueue } from "@/features/faltantes/receiver-queue";
import { StockoutList } from "@/features/faltantes/stockout-list";
import { requireCapability } from "@/lib/auth/require-role";
import {
  listReceiverQueue,
  resolveReceiverScope,
} from "@/server/services/missing-receiver.service";
import { listStockoutProducts } from "@/server/services/stockout.service";

export const metadata: Metadata = { title: "Recepción" };

// Cola operativa en vivo: nunca cachear.
export const dynamic = "force-dynamic";

// --------------------------------------------------------------------------
// RECEPCIÓN: la pantalla de bodega.
//
// Vivía como una proyección dentro de `/revision-faltantes`, y ahí el nombre le
// mentía: bodega no revisa faltantes, RECIBE MERCADERÍA. Peor todavía, marcaba
// la llegada del pedido de un cliente dentro de un módulo de estantería.
//
// UNA SOLA COLA con los dos orígenes. Bodega recibe cajas y no clasifica de
// dónde nació la demanda; cada fila lleva una etiqueta —Cliente o Estantería—
// para poder priorizar la descarga cuando hay alguien esperando. Partirle la
// cola en dos pantallas, una por cada módulo de gerencia, es exactamente cómo
// un día se pasa una llegada.
//
// El origen decide dónde COMPRA gerencia; el bulto físico decide dónde trabaja
// bodega. Son dos ejes distintos y por eso son tres pantallas, no dos.
//
// La minimización de datos vive en el servicio, no acá: el `select` no trae
// cliente, teléfono ni proveedor. Esta pantalla no podría mostrarlos ni
// queriendo.
// --------------------------------------------------------------------------
export default async function RecepcionPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  await requireCapability("canReceiveMissingItems");

  // El scope se resuelve contra los estados PERMITIDOS: escribir `?scope=lo-que-sea`
  // a mano cae en "Por recibir", no en un error. Y la consulta nunca pide
  // FALTANTE ni CANCELADO, así que la cola de compras no se filtra por acá.
  const scope = resolveReceiverScope((await searchParams).scope);
  const [items, stockouts] = await Promise.all([
    listReceiverQueue(scope),
    // Va en las DOS pestañas: el quiebre no depende de qué está mirando
    // bodega, y esconderlo en una sola lo volvería fácil de no ver nunca.
    listStockoutProducts(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Recepción"
        description="Lo que hay que recibir. Marcá la llegada y registrá la entrada."
      />
      {/* Arriba de la cola a propósito: hay clientes esperando un producto que
          quizá esté en el depósito sin cargar. Eso pesa más que seguir
          recibiendo lo que ya se pidió. */}
      <StockoutList items={stockouts} />

      <ReceiverQueue items={items} scope={scope} />
    </div>
  );
}
