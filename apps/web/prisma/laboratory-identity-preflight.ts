/**
 * Preflight de identidad canónica de laboratorios.
 *
 * La migración `20260828120000_add_laboratory_canonical_identity` ABORTA si la
 * base ya trae dos laboratorios que colapsan a la misma identidad canónica
 * ("Bayer" y "bayer", "Lab  Doble" y "Lab Doble"). Esa decisión es deliberada:
 * cuál fila sobrevive y a dónde apuntan sus productos es una decisión de
 * negocio, no de una migración.
 *
 * El problema operativo es CUÁNDO se entera uno. Sin este preflight, se entera
 * en el medio del despliegue, con la base ya respaldada pero el servicio a
 * mitad de camino. Con él, se entera antes de tocar nada y con tiempo para
 * resolverlo a mano.
 *
 * LA REGLA NO SE REIMPLEMENTA ACÁ. Se lee del archivo de migración real y se
 * instala como función TEMPORAL de la sesión (`pg_temp`), porque el preflight
 * corre ANTES de la migración y la función definitiva todavía no existe. Es la
 * misma técnica que ya usa `tests/postgres/laboratory-canonical-identity.pg.test.ts`
 * para ejercitar la guarda: si la regla cambia, este preflight cambia con ella
 * sin que nadie tenga que acordarse.
 *
 * Sobre `pg_temp`: vive en la sesión, es invisible para el resto de las
 * conexiones y desaparece al desconectar. No toca el esquema `public`, no toma
 * bloqueos sobre objetos reales y no puede pisar la función definitiva si la
 * base YA está migrada.
 */
import { readFileSync } from "node:fs";

// La migración es la única autoridad sobre la regla. El nombre va escrito una
// sola vez: si algún día se renombra la carpeta, esto falla ruidosamente al
// leer el archivo en vez de verificar una regla equivocada en silencio.
const MIGRATION_URL = new URL(
  "./migrations/20260828120000_add_laboratory_canonical_identity/migration.sql",
  import.meta.url,
);

const FUNCTION_NAME = "laboratory_canonical_identity";

/** Lo mínimo que este módulo necesita de un cliente Prisma o de una transacción. */
export type SqlRunner = {
  $executeRawUnsafe(query: string): Promise<number>;
  $queryRawUnsafe<T>(query: string): Promise<T>;
};

/** Un grupo de laboratorios que colapsan a la misma identidad canónica. */
export type IdentityConflict = {
  /** La identidad canónica compartida. */
  identity: string;
  /** Los nombres tal como están escritos hoy, en orden alfabético. */
  names: string[];
  /** Los ids de esas filas, en el mismo orden que `names`. */
  ids: string[];
};

/**
 * Extrae de la migración el `CREATE OR REPLACE FUNCTION` de la identidad
 * canónica y lo reapunta al esquema temporal de la sesión.
 */
export function temporaryIdentityFunctionSql(
  migrationSql = readFileSync(MIGRATION_URL, "utf8"),
): string {
  const start = migrationSql.indexOf(
    `CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}`,
  );
  const end = migrationSql.indexOf("$fn$;", start);
  if (start < 0 || end < 0) {
    throw new Error(
      `No se encontró la definición de ${FUNCTION_NAME}() en la migración de identidad canónica.`,
    );
  }

  const definition = migrationSql.slice(start, end + "$fn$;".length);

  // Un solo reemplazo, sobre el nombre de la función que se está declarando.
  // El cuerpo no vuelve a nombrarse a sí mismo, así que no hay más ocurrencias.
  return definition.replace(
    `FUNCTION ${FUNCTION_NAME}`,
    `FUNCTION pg_temp.${FUNCTION_NAME}`,
  );
}

/**
 * Busca grupos de laboratorios con identidad canónica repetida.
 *
 * Solo lee: instala la función en `pg_temp` y hace un SELECT agrupado. No
 * escribe, no borra y no reasigna nada. Devuelve `[]` cuando la tabla todavía
 * no existe (instalación nueva), que es un preflight exitoso: sin filas no hay
 * conflicto posible.
 *
 * Tiene que correr sobre UNA sola conexión —una transacción interactiva de
 * Prisma, por ejemplo—, porque `pg_temp` es de la sesión.
 */
export async function findIdentityConflicts(
  runner: SqlRunner,
): Promise<IdentityConflict[]> {
  const [table] = await runner.$queryRawUnsafe<{ present: boolean }[]>(
    `SELECT to_regclass('laboratories') IS NOT NULL AS present`,
  );
  if (!table?.present) return [];

  await runner.$executeRawUnsafe(temporaryIdentityFunctionSql());

  return runner.$queryRawUnsafe<IdentityConflict[]>(`
    SELECT identity, names, ids
      FROM (
        SELECT pg_temp.${FUNCTION_NAME}(name) AS identity,
               array_agg(name ORDER BY name, id) AS names,
               array_agg(id   ORDER BY name, id) AS ids
          FROM laboratories
         GROUP BY 1
        HAVING count(*) > 1
      ) grupos
     ORDER BY identity
  `);
}

/**
 * Arma el informe para quien tiene que resolver el bloqueo a mano.
 *
 * Solo nombres e ids de laboratorio: es lo mínimo para encontrar las filas y
 * decidir. No lleva credenciales, ni URL de conexión, ni datos de clientes.
 */
export function formatConflictReport(conflicts: IdentityConflict[]): string {
  const lines = conflicts.map((conflict) => {
    const rows = conflict.names
      .map((name, index) => `      - ${JSON.stringify(name)}  (id: ${conflict.ids[index]})`)
      .join("\n");
    return `  ${JSON.stringify(conflict.identity)}\n${rows}`;
  });

  return [
    `Hay ${conflicts.length} identidad(es) canónica(s) duplicada(s) en 'laboratories'.`,
    "La migración 20260828120000_add_laboratory_canonical_identity va a ABORTAR el despliegue.",
    "",
    ...lines,
    "",
    "Qué hacer: decidí a mano cuál fila queda y reasigná las relaciones de las otras",
    "(products.laboratoryId, y cualquier otra que apunte al laboratorio) ANTES de desplegar.",
    "Ni este chequeo ni la migración eligen, borran o reasignan filas por su cuenta.",
  ].join("\n");
}
