import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_ADMIN_EMAIL, resolveAdminEmail } from "./seed-bootstrap";

// --------------------------------------------------------------------------
// SEED_ADMIN_EMAIL: la variable que se documentaba y no llegaba.
//
// `seed.ts` la lee y `env.example` la ofrece, pero el servicio `seed` de
// `docker-compose.yml` no la propagaba al contenedor. Quien la definía en su
// `.env` obtenía igual el administrador por defecto — sin error, sin aviso, y
// sin forma de darse cuenta salvo intentando entrar con un usuario que nunca
// se creó.
//
// Hay dos pruebas distintas acá y las dos hacen falta:
//
//   1. La RESOLUCIÓN, que es lógica y se prueba con strings.
//   2. La PROPAGACIÓN, que es infraestructura. Ninguna prueba de TypeScript la
//      habría detectado, porque el defecto no estaba en el código: estaba en
//      que el código nunca recibía el dato. Por eso esta se lee del archivo
//      YAML real.
// --------------------------------------------------------------------------

const RAIZ = new URL("../../../", import.meta.url);
const COMPOSE = fileURLToPath(new URL("docker-compose.yml", RAIZ));
const SEED_TS = fileURLToPath(new URL("seed.ts", import.meta.url));
const ENV_EXAMPLE = fileURLToPath(new URL("env.example", RAIZ));

/**
 * El bloque `environment:` de un servicio de compose, por indentación.
 *
 * Se lee el YAML real en vez de un parser: agregar una dependencia para leer
 * cuatro líneas de un archivo que casi no cambia costaría más de lo que evita.
 */
function environmentOf(service: string): string {
  const yaml = readFileSync(COMPOSE, "utf8");
  const desde = yaml.indexOf(`\n  ${service}:`);
  if (desde < 0) throw new Error(`no existe el servicio '${service}' en docker-compose.yml`);
  const resto = yaml.slice(desde + 1);
  // El servicio termina donde arranca otro al mismo nivel (dos espacios).
  const hasta = resto.search(/\n {2}\S[^\n]*:\n/);
  const bloque = hasta < 0 ? resto : resto.slice(0, hasta);
  const env = bloque.indexOf("environment:");
  if (env < 0) return "";
  const tras = bloque.slice(env);
  const fin = tras.search(/\n {4}\S[^\n]*:\n/);
  return fin < 0 ? tras : tras.slice(0, fin);
}

/** Las variables `SEED_*` que el ejecutable del seed lee de verdad. */
function seedEnvVars(): string[] {
  const fuente = readFileSync(SEED_TS, "utf8");
  const encontradas = [...fuente.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]!);
  return [...new Set(encontradas)].filter((v) => v.startsWith("SEED_"));
}

describe("resolveAdminEmail · qué administrador busca el seed", () => {
  it("usa el que se configuró", () => {
    expect(resolveAdminEmail("gerencia@drogueria.com")).toBe("gerencia@drogueria.com");
  });

  it("recorta los espacios de un `.env` copiado a mano", () => {
    expect(resolveAdminEmail("  gerencia@drogueria.com  ")).toBe("gerencia@drogueria.com");
  });

  // El caso que hace que esto sea una función y no un `??`.
  //
  // Compose pasa `"${SEED_ADMIN_EMAIL:-}"`, así que cuando la variable no está
  // en el `.env` llega DEFINIDA y vacía. Un `??` no la atrapa: el seed habría
  // buscado un usuario con email "" y, al no encontrarlo, habría intentado
  // crear un SUPERADMIN sin email.
  it("la cadena vacía que inyecta Compose cae en el valor por defecto", () => {
    expect(resolveAdminEmail("")).toBe(DEFAULT_ADMIN_EMAIL);
  });

  it("una cadena de solo espacios, también", () => {
    expect(resolveAdminEmail("   ")).toBe(DEFAULT_ADMIN_EMAIL);
  });

  it("sin la variable, el valor por defecto", () => {
    expect(resolveAdminEmail(undefined)).toBe(DEFAULT_ADMIN_EMAIL);
    expect(resolveAdminEmail(null)).toBe(DEFAULT_ADMIN_EMAIL);
  });

  // Compatibilidad: una instalación que ya está andando y NO define la variable
  // tiene que seguir apuntando al mismo administrador. Si este valor cambia, el
  // seed sale a buscar un usuario que no existe y crea un SUPERADMIN nuevo.
  it("el valor por defecto es el de las instalaciones que ya existen", () => {
    expect(DEFAULT_ADMIN_EMAIL).toBe("admin@ilasesorias.com");
    expect(resolveAdminEmail(undefined)).toBe("admin@ilasesorias.com");
  });

  it("nunca devuelve vacío: el seed siempre tiene a quién buscar", () => {
    for (const entrada of ["", "   ", undefined, null]) {
      expect(resolveAdminEmail(entrada).length).toBeGreaterThan(0);
    }
  });
});

// --------------------------------------------------------------------------
// La prueba que faltaba: el puente entre el código y el contenedor.
// --------------------------------------------------------------------------
describe("docker-compose · el seed recibe lo que lee", () => {
  it("propaga SEED_ADMIN_EMAIL al contenedor", () => {
    expect(environmentOf("seed")).toContain("SEED_ADMIN_EMAIL");
  });

  // La invariante de verdad, y la que evita que esto vuelva a pasar: si mañana
  // alguien le agrega otra `SEED_*` a `seed.ts` y se olvida del compose, esta
  // prueba lo dice. Deriva la lista del código en vez de repetirla.
  it("propaga TODAS las SEED_* que el ejecutable lee", () => {
    const env = environmentOf("seed");
    const leidas = seedEnvVars();

    expect(leidas.length).toBeGreaterThan(0);
    for (const variable of leidas) {
      expect(env, `docker-compose.yml no le pasa ${variable} al servicio seed`).toContain(
        variable,
      );
    }
  });

  // Se pasa vacía y decide el código, igual que la contraseña. Ponerle el valor
  // por defecto acá lo duplicaría en dos lugares que se separan con el tiempo.
  it("la pasa sin valor por defecto: quien decide es el código", () => {
    expect(environmentOf("seed")).toContain('SEED_ADMIN_EMAIL: "${SEED_ADMIN_EMAIL:-}"');
  });

  // El servicio `web` NO tiene por qué recibirla: no siembra nada.
  it("no se la pasa a la web, que no siembra", () => {
    expect(environmentOf("web")).not.toContain("SEED_ADMIN_EMAIL");
  });
});

describe("env.example · lo documentado existe de verdad", () => {
  it("sigue ofreciendo la variable", () => {
    expect(readFileSync(ENV_EXAMPLE, "utf8")).toContain("SEED_ADMIN_EMAIL");
  });

  it("el valor por defecto que documenta es el real", () => {
    expect(readFileSync(ENV_EXAMPLE, "utf8")).toContain(DEFAULT_ADMIN_EMAIL);
  });
});
