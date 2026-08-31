import { describe, expect, it } from "vitest";

import { config } from "./proxy";

// --------------------------------------------------------------------------
// El matcher decide qué rutas quedan FUERA del guard de sesión. Una exclusión
// de más es un endpoint público que nadie pidió.
//
// `api/version` sin ancla abriría también `/api/version-private` y
// `/api/version/secret`: un prefijo deja pasar todo lo que empiece igual, y
// basta que alguien cree una ruta con ese nombre para regalar acceso sin sesión.
// --------------------------------------------------------------------------

// Next evalúa el matcher contra la ruta ENTERA. Sin anclar, `test` encuentra
// coincidencias parciales y la prueba mediría otra cosa.
const matcher = new RegExp(`^${config.matcher[0]!}$`);

/** Si el proxy intercepta esa ruta (y por lo tanto exige sesión). */
function intercepta(pathname: string): boolean {
  return matcher.test(pathname);
}

describe("proxy · qué queda fuera del guard", () => {
  it.each(["/api/version", "/api/version/"])(
    "deja pasar %s sin sesión",
    (ruta) => {
      expect(intercepta(ruta)).toBe(false);
    },
  );

  it("sigue dejando pasar el healthcheck", () => {
    expect(intercepta("/api/health")).toBe(false);
  });

  // Lo que la exclusión NO puede abrir.
  it.each([
    "/api/version-private",
    "/api/version/secret",
    "/api/versionado",
    "/api/version/2/interno",
  ])("PROTEGE %s", (ruta) => {
    expect(intercepta(ruta)).toBe(true);
  });

  it("protege las rutas de la aplicación", () => {
    for (const ruta of ["/pendientes", "/entradas", "/admin", "/api/otra"]) {
      expect(intercepta(ruta)).toBe(true);
    }
  });

  it("deja pasar los estáticos de /public", () => {
    expect(intercepta("/logo-especifica.webp")).toBe(false);
    expect(intercepta("/favicon.ico")).toBe(false);
  });
});
