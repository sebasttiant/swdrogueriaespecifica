import { NextResponse } from "next/server";

import { APP_VERSION } from "@/lib/deployment/app-version";

// Nunca se cachea: una respuesta guardada seguiría afirmando la versión vieja
// justo después de un despliegue, que es el único momento en que este endpoint
// tiene algo que decir.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * La versión del build que está sirviendo.
 *
 * Devuelve ESO y nada más. No lleva hostname, rutas, variables ni estado: es
 * público por necesidad —lo consulta el navegador sin sesión establecida— y
 * cualquier dato de más sería superficie regalada.
 */
export function GET() {
  return NextResponse.json(
    { version: APP_VERSION },
    { headers: { "Cache-Control": "no-store" } },
  );
}
