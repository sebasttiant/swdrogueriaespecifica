import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { PendingIdentityQueue } from "@/features/pendientes/pending-identity-queue";
import { requireCapability } from "@/lib/auth/require-role";
import { getPendingIdentityQueue } from "@/server/services/pending.service";

export const metadata: Metadata = { title: "Revisión de identidad" };

// Cola operativa en vivo: nunca cachear. Un producto sale de la cola en cuanto
// alguien le carga el código, y una página cacheada mandaría a vincular algo
// que ya está vinculado.
export const dynamic = "force-dynamic";

const BASE_PATH = "/revision-identidad-pendientes";

// --------------------------------------------------------------------------
// Revisión de identidad: los productos que quedaron esperando su código de
// Orion porque alguien usó la salida con motivo al capturar un pendiente.
//
// La página es FINA a propósito: guard → servicio → render. No calcula alcance,
// no arma `ownerId` y no vuelve a preguntar por roles. Todo eso ya lo decidió
// `getPendingIdentityQueue`, contra la matriz de capacidades, con sus tests.
// Si acá apareciera una segunda decisión sobre quién ve qué, las dos copias se
// separarían, y la que filtra de más no avisa: devuelve más filas, sin error.
//
// El guard usa `canFixProductIdentity`, exactamente la capacidad que exige el
// servicio. No es una segunda matriz: es el MISMO nombre. Pedir otra cosa
// abriría la puerta a que el portón y la cerradura no coincidan, y el módulo
// mostraría un link que termina en redirect.
//
// El cursor sale de la URL y entra al servicio tal cual. Es opaco: esta página
// no sabe —ni tiene por qué saber— que adentro viaja `cantidad:productId`.
// --------------------------------------------------------------------------
export default async function RevisionIdentidadPendientesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await requireCapability("canFixProductIdentity");

  const { cursor } = await searchParams;

  const queue = await getPendingIdentityQueue({
    role: session.user.role,
    userId: session.user.id,
    cursor,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Revisión de identidad"
        description="Productos con pendientes abiertos que todavía no tienen su código de Orion. Sin ese código no se puede cuadrar el inventario."
      />

      <PendingIdentityQueue
        items={queue.items}
        nextCursor={queue.nextCursor}
        pageHref={(next) => `${BASE_PATH}?cursor=${encodeURIComponent(next)}`}
      />
    </div>
  );
}
