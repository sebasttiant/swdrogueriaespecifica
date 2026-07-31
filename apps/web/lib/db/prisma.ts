import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client";
import { getServerEnv } from "../env";

// --------------------------------------------------------------------------
// Prisma 7 (rust-free) con driver adapter de Postgres.
// Singleton para evitar múltiples conexiones en dev (hot reload).
// Server-only: NUNCA importar esto desde middleware (Edge) ni componentes cliente.
//
// LAZY a propósito: la creación del cliente (y la validación fail-fast de env)
// se difiere al PRIMER USO real vía Proxy. Así `next build` puede importar
// módulos que dependen de Prisma sin requerir secretos en build; el cliente se
// crea recién en runtime, cuando DATABASE_URL ya está presente.
// --------------------------------------------------------------------------

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

// --------------------------------------------------------------------------
// Pool de conexiones.
//
// Sin configurar, `pg` abre como máximo 10 conexiones y espera un cupo libre
// PARA SIEMPRE cuando se acaban. Ese fue el síntoma en producción: la primera
// acción funcionaba y la segunda dejaba el botón girando sin error, porque
// estaba haciendo cola por una conexión que no se liberaba a tiempo.
//
// Cada transacción interactiva retiene una conexión mientras dura —incluidos
// los `SELECT ... FOR UPDATE` de reserva—, y cada `revalidatePath` vuelve a
// renderizar la ruta con sus propias consultas. Con dos o tres personas
// trabajando a la vez, diez cupos se agotan enseguida.
//
// `connectionTimeoutMillis` es lo más importante de acá: si el pool igual se
// agota, la petición FALLA con un mensaje en vez de colgarse. Un error que se
// ve se puede reintentar; un botón girando no le dice nada a nadie.
//
// CÓMO SE DIMENSIONA (y por qué NO es "una conexión por usuario").
//
// El objetivo son ~300 personas usando la droguería. Eso NO significa 300
// conexiones: una petición web sostiene la conexión unas decenas de
// milisegundos y la devuelve. 30 conexiones que rotan rápido atienden cientos
// de usuarios concurrentes sin despeinarse.
//
// El techo real no lo pone la gente, lo pone PostgreSQL: `max_connections` es
// 100 por defecto, y de ahí hay que dejar aire para las migraciones del deploy,
// el seed, los respaldos y cualquier `psql` de soporte. Pedir más que eso no da
// más capacidad —hace que Postgres rechace conexiones.
//
// Con una sola instancia de la app, 30 es holgado y seguro. Si algún día hay
// más instancias, este número se reparte entre ellas: dos instancias con 30
// cada una son 60 conexiones contra la misma base. Por eso queda en una
// variable de entorno, para ajustarlo sin tocar código.
const POOL_MAX = Number(process.env.DATABASE_POOL_MAX ?? 30);
// Si en 10s no hay cupo, algo está mal de verdad: mejor un error visible que
// una espera infinita.
const POOL_ACQUIRE_TIMEOUT_MS = Number(
  process.env.DATABASE_POOL_ACQUIRE_TIMEOUT_MS ?? 10_000,
);
// Las conexiones ociosas se sueltan: en horas muertas la droguería no tiene por
// qué mantener 30 conexiones abiertas contra la base.
const POOL_IDLE_TIMEOUT_MS = 30_000;

function createPrismaClient(): PrismaClient {
  const { DATABASE_URL } = getServerEnv();
  const adapter = new PrismaPg({
    connectionString: DATABASE_URL,
    max: POOL_MAX,
    connectionTimeoutMillis: POOL_ACQUIRE_TIMEOUT_MS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  });
  return new PrismaClient({ adapter });
}

let cached: PrismaClient | undefined;

function getPrismaClient(): PrismaClient {
  if (cached) return cached;
  cached = globalForPrisma.prisma ?? createPrismaClient();
  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = cached;
  return cached;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrismaClient();
    const value = Reflect.get(client, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
