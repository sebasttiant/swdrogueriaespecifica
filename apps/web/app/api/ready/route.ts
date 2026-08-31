import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { checkReadiness } from "@/lib/health/readiness";

// --------------------------------------------------------------------------
// Readiness: la aplicación puede consultar PostgreSQL.
//
// Va SEPARADO de `/api/health`, que sigue sin tocar la base. La diferencia no
// es cosmética:
//
//   /api/health  liveness   -> ¿el proceso web responde?  Lo mira el
//                             healthcheck de Docker, que REINICIA lo que
//                             encuentra enfermo.
//   /api/ready   readiness  -> ¿la aplicación llega a la base?  Lo mira una
//                             persona, o un balanceador para dejar de mandar
//                             tráfico. Nadie reinicia nada por esto.
//
// Por eso este endpoint NO se conecta al healthcheck de `docker-compose.yml`:
// un corte momentáneo de la base marcaría el contenedor como enfermo y Docker
// lo reiniciaría. Reiniciar la web no levanta una base caída; solo suma una
// caída más y borra el estado en memoria. Un fallo transitorio se informa, no
// se convierte en una operación destructiva.
// --------------------------------------------------------------------------

// Sin caché: una respuesta de readiness guardada describe un pasado.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const result = await checkReadiness(
    // La consulta más barata que prueba lo que importa: que haya conexión y
    // que el servidor conteste. No mira tablas —un readiness que depende del
    // esquema falla durante una migración, que es justo cuando hay que poder
    // distinguir "migrando" de "caída".
    () => prisma.$queryRaw`SELECT 1`,
    {
      // El error completo va al log del servidor, que es privado. En la
      // respuesta no va: este endpoint contesta sin autenticación y el mensaje
      // de un error de conexión de PostgreSQL nombra host, puerto, base y
      // usuario.
      //
      // Se registra el error ENTERO, no `error.message`. Medido contra un
      // PostgreSQL apagado de verdad: el error del driver llega con `message`
      // vacío, así que loguear solo eso dejaba la línea
      // "[readiness] la base no respondió:" sin nada detrás. Un log que no dice
      // qué pasó es lo mismo que no tenerlo, y convierte una caída en un
      // misterio. El log del servidor es privado: ahí el detalle completo va.
      onError: (error) => {
        console.error("[readiness] la base no respondió:", error);
      },
    },
  );

  return NextResponse.json(
    {
      status: result.ready ? "ready" : "unavailable",
      service: "drogueria-especifica-web",
      // Categoría, nunca el error. Le dice a quien opera qué mirar sin
      // publicar nada de la conexión.
      ...(result.ready ? {} : { reason: result.reason }),
      timestamp: new Date().toISOString(),
    },
    {
      // 503 y no 500: no es un error de la petición, es "todavía no puedo
      // atender". Es lo que un balanceador entiende como "sacame de rotación".
      status: result.ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
