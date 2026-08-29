import { NextResponse } from "next/server";

import {
  APP_VERSION,
  assertVersionConfigured,
} from "@/lib/deployment/app-version";

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
  // En producción, una imagen sin versión apaga el guard en silencio. Se falla
  // acá —donde se nota— en vez de servir un `unknown` que nadie mira.
  assertVersionConfigured();

  return NextResponse.json(
    { version: APP_VERSION },
    { headers: { "Cache-Control": "no-store" } },
  );
}
