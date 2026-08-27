// --------------------------------------------------------------------------
// Repositorio de laboratorios — ÚNICO lugar que toca Prisma para `Laboratory`.
//
// Patrón: findOrCreate con idempotencia por searchKey. La transacción es
// CORTA — solo crea el laboratorio y retorna. No se mezcla con operaciones
// de inventario ni de pendientes.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Laboratory, Prisma } from "@/lib/generated/prisma/client";

import {
  normalizeLaboratoryName,
  type LaboratoryCandidate,
} from "@/server/domain/laboratory/identity";

// --------------------------------------------------------------------------
// Búsqueda normalizada — 8 resultados, prefijos primero.
// --------------------------------------------------------------------------

const SEARCH_LIMIT = 8;

/**
 * Busca laboratorios por nombre normalizado. Devuelve máximo 8 resultados
 * con prefijos primero. NO mergea: candidatos similares se muestran como
 * opciones separadas.
 */
export async function searchLaboratories(
  query: string,
  client: Prisma.TransactionClient = prisma,
): Promise<LaboratoryCandidate[]> {
  const normalized = normalizeLaboratoryName(query);
  if (normalized.length === 0) return [];

  try {
    // Buscar por searchKey (preciso) y por name ILIKE (fuzzy).
    // El OR cubre ambos casos: searchKey para los que ya lo tienen, ILIKE para
    // los que todavía no (pre-T2 o needsReview).
    const rows = await client.$queryRawUnsafe<LaboratoryCandidate[]>(
      `SELECT id, name, "searchKey", "needsReview"
         FROM laboratories
        WHERE "searchKey" = ${normalized}
           OR name ILIKE ${`%${normalized}%`}
        ORDER BY
          CASE WHEN "searchKey" = ${normalized} THEN 0 ELSE 1 END,
          name
        LIMIT ${SEARCH_LIMIT}`,
    );

    return rows;
  } catch {
    // Si la tabla no existe aún o la query falla, devolver vacío.
    // El componente mostrará "Crear" para que el usuario lo cree.
    return [];
  }
}

// --------------------------------------------------------------------------
// Creación idempotente — resolve-or-create en transacción corta.
// --------------------------------------------------------------------------

export type CreateLaboratoryData = {
  name: string;
  /** Clave de idempotencia del intento de creación. */
  commandKey?: string;
  /** Huella del contenido del comando. */
  commandFingerprint?: string;
  /** Marca para revisión manual (default: false). */
  needsReview?: boolean;
};

export type LaboratoryRecord =
  | { status: "created"; laboratory: Laboratory }
  | { status: "exists"; laboratory: Laboratory }
  | { status: "exact_name_exists"; laboratory: Laboratory };

/**
 * El conflicto esperado no resolvió a ninguna fila.
 *
 * No ocurre por vía natural: un choque contra `searchKey` siempre lo encuentra
 * la búsqueda por `searchKey`, y lo mismo con `createCommandKey`. Llegar acá
 * significa que la fila se borró entre el INSERT y la lectura, o que chocó un
 * índice que este código no contempla. Se nombra en vez de devolver `undefined`
 * y romper más adelante, lejos de la causa.
 */
export class LaboratoryResolutionInvariantError extends Error {
  constructor(searchKey: string) {
    super(`laboratory insert conflicted but resolved to no row (searchKey=${searchKey})`);
  }
}

/**
 * Resolve-or-create idempotente.
 *
 * El INSERT usa `ON CONFLICT DO NOTHING` SIN target —vía `skipDuplicates`— a
 * propósito: la tabla tiene DOS índices únicos parciales, `searchKey` y
 * `createCommandKey`, y acotar el target a uno dejaría que el otro lanzara un
 * error. Eso importa más de lo que parece, porque en PostgreSQL un error aborta
 * la transacción ENTERA: cualquier consulta posterior falla con 25P02. Un
 * conflicto que se espera no puede viajar como excepción si esta función va a
 * poder usarse dentro de una transacción más grande.
 *
 * Los tres resultados:
 *
 * - `created`: el INSERT devolvió fila, nadie compitió.
 * - `exists`: no insertó y el nombre normalizado ya estaba. Cubre tanto "ya
 *   existía" como "otro proceso ganó la carrera", que para el llamador son lo
 *   mismo: el laboratorio que pidió, ya está.
 * - `exact_name_exists`: no insertó, el nombre NO está, y quien ocupaba el
 *   lugar es el mismo `commandKey` con OTRO nombre. Es un intento que cambió de
 *   idea, no una carrera. Se nombra para que el llamador decida: devolver el
 *   laboratorio viejo en silencio sería sustituir lo que la persona pidió.
 *
 * La transacción es corta: solo laboratorio, sin tocar inventario.
 */
export async function findOrCreateLaboratory(
  data: CreateLaboratoryData,
  client: Prisma.TransactionClient = prisma,
): Promise<LaboratoryRecord> {
  const searchKey = normalizeLaboratoryName(data.name);

  // 1. Camino feliz y carrera perdida, en una sola sentencia.
  //
  // `skipDuplicates` es lo que Prisma traduce a `ON CONFLICT DO NOTHING`, y
  // `createManyAndReturn` es lo que agrega el `RETURNING`: si insertó, vuelve
  // la fila; si chocó, vuelve vacío y ningún error. El id lo genera el
  // `@default(cuid())` del modelo, igual que en cualquier otro create.
  //
  // Además espera: si otra transacción tiene un INSERT sin commitear del mismo
  // searchKey, esta se queda esperando su desenlace en vez de adivinarlo.
  const inserted = await client.laboratory.createManyAndReturn({
    data: [{
      name: data.name.trim(),
      searchKey,
      needsReview: data.needsReview ?? false,
      ...(data.commandKey ? { createCommandKey: data.commandKey } : {}),
      ...(data.commandFingerprint
        ? { createCommandFingerprint: data.commandFingerprint }
        : {}),
    }],
    skipDuplicates: true,
  });

  if (inserted[0]) {
    return { status: "created", laboratory: inserted[0] };
  }

  // 2. No insertó. El nombre normalizado es lo que el llamador pidió, así que
  //    se busca por ahí primero.
  const bySearchKey = await client.laboratory.findUnique({ where: { searchKey } });
  if (bySearchKey) {
    return { status: "exists", laboratory: bySearchKey };
  }

  // 3. El nombre no está: entonces quien bloqueó el INSERT fue el commandKey.
  //    Mismo comando, otro laboratorio.
  if (data.commandKey) {
    const byCommandKey = await client.laboratory.findUnique({
      where: { createCommandKey: data.commandKey },
    });
    if (byCommandKey) {
      return { status: "exact_name_exists", laboratory: byCommandKey };
    }
  }

  // 4. Chocó contra algo y no resolvió a nada. Ver la nota del error.
  throw new LaboratoryResolutionInvariantError(searchKey);
}

/**
 * Busca un laboratorio por ID. Retorna null si no existe.
 */
export async function findLaboratoryById(
  id: string,
  client: Prisma.TransactionClient = prisma,
): Promise<Laboratory | null> {
  return client.laboratory.findUnique({ where: { id } });
}

/**
 * Lista todos los laboratorios activos (para selects/autocomplete).
 */
export async function listLaboratories(
  client: Prisma.TransactionClient = prisma,
): Promise<Pick<Laboratory, "id" | "name" | "searchKey" | "needsReview">[]> {
  return client.laboratory.findMany({
    select: { id: true, name: true, searchKey: true, needsReview: true },
    orderBy: { name: "asc" },
  });
}
