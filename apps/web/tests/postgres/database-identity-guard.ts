// --------------------------------------------------------------------------
// Guard de identidad de la base de datos del harness de PostgreSQL.
//
// El harness crea y BORRA bases de datos. Todo lo que decide contra qué
// cluster se trabaja y qué nombre se puede borrar vive acá, puro y sin I/O,
// para poder probar los invariantes de seguridad sin tocar ninguna base.
//
// Reglas, en una línea:
//  1. Sin `TEST_DATABASE_URL` explícita no se corre nada. Nunca se cae por
//     defecto a la `DATABASE_URL` de la aplicación.
//  2. La base descartable la nombramos nosotros, siempre con el prefijo
//     `drogueria_test_`. Solo se borra lo que se pudo haber creado.
//  3. Ni en producción, ni contra el mismo destino que la aplicación.
// --------------------------------------------------------------------------

export const DISPOSABLE_DATABASE_PREFIX = "drogueria_test_";

// Postgres trunca los identificadores a 63 bytes. Si el nombre creado no
// fuera exactamente el borrado, el teardown dejaría bases huérfanas.
const MAX_IDENTIFIER_LENGTH = 63;

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

// Bases de mantenimiento: existen en cualquier cluster y no guardan datos de
// la operación. Son el único punto de entrada válido para un `CREATE DATABASE`.
const MAINTENANCE_DATABASES = new Set(["postgres", "template1"]);

const DISPOSABLE_NAME_PATTERN = new RegExp(
  `^${DISPOSABLE_DATABASE_PREFIX}[a-z0-9_]+$`,
);

export type DisposableUrlContext = {
  /** `process.env.NODE_ENV` del proceso que corre el harness. */
  nodeEnv?: string;
  /** `process.env.DATABASE_URL`: el destino real de la aplicación. */
  appDatabaseUrl?: string;
};

function parsePostgresUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(
      "TEST_DATABASE_URL no es una URL válida. Se espera algo como " +
        "postgresql://usuario:clave@host:5432/postgres",
    );
  }

  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `TEST_DATABASE_URL debe apuntar a postgres, no a "${url.protocol}".`,
    );
  }

  return url;
}

function databaseNameOf(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

/**
 * Valida la URL base contra la que el harness va a crear su base descartable.
 * Devuelve la URL parseada; lanza con un mensaje accionable si algo no cierra.
 */
export function assertDisposableBaseUrl(
  rawUrl: string | undefined,
  { nodeEnv, appDatabaseUrl }: DisposableUrlContext = {},
): URL {
  if (nodeEnv === "production") {
    throw new Error(
      "El harness de PostgreSQL no corre en producción (NODE_ENV=production).",
    );
  }

  if (!rawUrl || rawUrl.trim() === "") {
    throw new Error(
      "Falta TEST_DATABASE_URL. El harness nunca reutiliza la DATABASE_URL de " +
        "la aplicación: apuntá TEST_DATABASE_URL a un PostgreSQL descartable.",
    );
  }

  const url = parsePostgresUrl(rawUrl.trim());
  const database = databaseNameOf(url);

  // El destino de la aplicación se mira primero: es el error más peligroso y
  // merece el diagnóstico más preciso.
  if (appDatabaseUrl && isSameTarget(url, appDatabaseUrl)) {
    throw new Error(
      "TEST_DATABASE_URL apunta al mismo destino que la aplicación " +
        "(host, puerto y base). El harness necesita un PostgreSQL aparte.",
    );
  }

  if (
    !MAINTENANCE_DATABASES.has(database) &&
    !DISPOSABLE_NAME_PATTERN.test(database)
  ) {
    throw new Error(
      `TEST_DATABASE_URL apunta a la base "${database}", que no es descartable. ` +
        `Usá una base de mantenimiento (${[...MAINTENANCE_DATABASES].join(", ")}) ` +
        `o una que empiece con "${DISPOSABLE_DATABASE_PREFIX}".`,
    );
  }

  return url;
}

// Una URL de aplicación ilegible no habilita nada: si no se puede comparar, se
// asume que no coincide, pero el resto de las reglas sigue en pie.
function isSameTarget(url: URL, appDatabaseUrl: string): boolean {
  let appUrl: URL;
  try {
    appUrl = new URL(appDatabaseUrl);
  } catch {
    return false;
  }

  return (
    url.hostname === appUrl.hostname &&
    url.port === appUrl.port &&
    databaseNameOf(url) === databaseNameOf(appUrl)
  );
}

/**
 * Construye el nombre de la base descartable. El sufijo se normaliza al juego
 * de caracteres seguro de un identificador de Postgres.
 */
export function createDisposableDatabaseName(suffix: string): string {
  const normalized = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (normalized === "") {
    throw new Error(
      `El sufijo "${suffix}" no deja ningún carácter usable para el nombre de la base.`,
    );
  }

  const name = `${DISPOSABLE_DATABASE_PREFIX}${normalized}`.slice(
    0,
    MAX_IDENTIFIER_LENGTH,
  );

  assertDisposableDatabaseName(name);
  return name;
}

/**
 * Último filtro antes de un `CREATE DATABASE` o un `DROP DATABASE`: el nombre
 * tiene que ser uno que este harness pudo haber creado.
 */
export function assertDisposableDatabaseName(name: string): void {
  if (!DISPOSABLE_NAME_PATTERN.test(name)) {
    throw new Error(
      `"${name}" no es una base descartable del harness: el nombre debe empezar ` +
        `con "${DISPOSABLE_DATABASE_PREFIX}" y usar solo [a-z0-9_].`,
    );
  }

  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(
      `"${name}" supera los ${MAX_IDENTIFIER_LENGTH} caracteres que Postgres ` +
        "admite en un identificador.",
    );
  }
}

/** URL de conexión a la base descartable, conservando destino y parámetros. */
export function buildDisposableDatabaseUrl(
  baseUrl: string,
  databaseName: string,
): string {
  assertDisposableDatabaseName(databaseName);

  const url = parsePostgresUrl(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * Cita el identificador para interpolarlo en SQL. `CREATE DATABASE` y
 * `DROP DATABASE` no admiten parámetros, así que el nombre viaja en el texto:
 * por eso pasa antes por el guard.
 */
export function quoteIdentifier(name: string): string {
  assertDisposableDatabaseName(name);
  return `"${name}"`;
}
