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
 * Escapa caracteres especiales de LIKE con el prefijo de escape '!'
 * para que %, _ y ! del input del usuario se traten como literales.
 */
function escapeLike(input: string): string {
  return input.replace(/[%_!]/g, "!$&");
}

/**
 * Busca laboratorios por nombre normalizado. Devuelve máximo 8 resultados
 * con coincidencia exacta primero, prefijos después, y el resto alfabéticamente.
 * NO mergea: candidatos similares se muestran como opciones separadas.
 *
 * Usa $queryRaw con parámetros atados (no interpolación) para prevenir
 * inyección SQL. El LIKE usa ESCAPE '!' para tratar metacaracteres como literales.
 *
 * NO atrapa errores de base. Antes había un `catch` que devolvía `[]` cuando
 * "la tabla no existía todavía", y era doblemente equivocado:
 *
 * - `laboratories` existe desde `20260709130000_add_laboratory`. Lo que puede
 *   faltar antes de la migración de trazabilidad son COLUMNAS —`searchKey`,
 *   `needsReview`—, y eso es `42703`, no `42P01`.
 * - Prisma 7 no expone el SQLSTATE en `.code`: ahí pone `P2010` y guarda el
 *   código real en `meta.driverAdapterError.cause.originalCode`. La condición
 *   nunca podía cumplirse; era código muerto que documentaba una garantía
 *   inexistente.
 *
 * Y aunque se hubiera escrito bien, devolver `[]` es la respuesta peligrosa:
 * una lista vacía le dice al operador "este laboratorio no está, creálo", que
 * es justo cómo se fabrican identidades duplicadas. `searchLaboratoriesAction`
 * ya convierte cualquier excepción en `{ ok: false, error }` y la pantalla la
 * muestra. Una base rota se ve como base rota.
 */
export async function searchLaboratories(
  query: string,
  client: Prisma.TransactionClient = prisma,
): Promise<LaboratoryCandidate[]> {
  const normalized = normalizeLaboratoryName(query);
  if (normalized.length === 0) return [];

  const escapedQuery = escapeLike(normalized);

  // Búsqueda segura: parámetros atados via Prisma $queryRaw.
  // LIKE con ESCAPE '!' trata %, _, e ! del input como literales.
  // Orden: exacto (0) > prefijo (1) > contiene (2) > alfabético.
  return client.$queryRaw<LaboratoryCandidate[]>`
    SELECT id, name, "searchKey", "needsReview"
      FROM laboratories
     WHERE "searchKey" = ${normalized}
        OR name ILIKE ${`%${escapedQuery}%`} ESCAPE '!'
     ORDER BY
       CASE WHEN "searchKey" = ${normalized} THEN 0
            WHEN name ILIKE ${`${escapedQuery}%`} ESCAPE '!' THEN 1
            ELSE 2 END,
       name
     LIMIT ${SEARCH_LIMIT}
  `;
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
 * No ocurre por vía natural: cada uno de los tres índices únicos de la tabla
 * tiene su lectura —`searchKey`, `name` y `createCommandKey`—, así que el
 * conflicto que los produjo resuelve a una fila. Llegar acá significa que la
 * fila se borró entre el INSERT y la lectura, o que chocó un índice que este
 * código no contempla. Se nombra en vez de devolver `undefined`
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
 * propósito: la tabla tiene TRES índices únicos y acotar el target a uno
 * dejaría que los otros lanzaran un error. Eso importa más de lo que parece,
 * porque en PostgreSQL un error aborta la transacción ENTERA: cualquier
 * consulta posterior falla con 25P02. Un conflicto que se espera no puede
 * viajar como excepción si esta función va a poder usarse dentro de una
 * transacción más grande.
 *
 * Los tres índices, y por qué el orden de las lecturas es ese:
 *
 * - `laboratories_searchKey_key`, parcial: la identidad canónica. Se lee
 *   primero porque es lo que el llamador realmente pidió.
 * - `laboratories_name_key`, TOTAL y sobre columna NOT NULL: existe desde la
 *   primera migración de la tabla. Los laboratorios anteriores a
 *   `20260826190000_add_laboratory_traceability` tienen `searchKey` NULL —esa
 *   migración agrega la columna y no la rellena—, así que no ocupan ninguna
 *   clave de búsqueda y el único índice contra el que chocan es este.
 * - `laboratories_createCommandKey_key`, parcial: el intento, no el nombre.
 *
 * Los tres resultados:
 *
 * - `created`: el INSERT devolvió fila, nadie compitió.
 * - `exists`: no insertó y el laboratorio que se pidió ya estaba, sea por su
 *   `searchKey` o por su nombre exacto. Cubre "ya existía", "otro proceso ganó
 *   la carrera" y "es una fila histórica", que para el llamador son lo mismo:
 *   el laboratorio que pidió, ya está.
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

  // 3. No hay fila con ese `searchKey`, pero el nombre puede estar ocupado
  //    igual: es el caso de los laboratorios previos a la migración de
  //    trazabilidad, que quedaron con `searchKey` NULL. La lectura es por el
  //    mismo nombre exacto que se intentó insertar, así que solo puede
  //    devolver la fila que bloqueó el índice — nunca una vecina.
  //
  //    No se le rellena el `searchKey` acá a propósito: sería un UPDATE
  //    dentro de una función de resolución, y un choque contra el único
  //    parcial de `searchKey` abortaría la transacción del llamador. Rellenar
  //    filas históricas es trabajo de una migración, no de una lectura.
  const byName = await client.laboratory.findUnique({
    where: { name: data.name.trim() },
  });
  if (byName) {
    return { status: "exists", laboratory: byName };
  }

  // 4. El nombre tampoco está: entonces quien bloqueó el INSERT fue el
  //    commandKey. Mismo comando, otro laboratorio.
  if (data.commandKey) {
    const byCommandKey = await client.laboratory.findUnique({
      where: { createCommandKey: data.commandKey },
    });
    if (byCommandKey) {
      return { status: "exact_name_exists", laboratory: byCommandKey };
    }
  }

  // 5. Chocó contra algo y no resolvió a nada. Ver la nota del error.
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
