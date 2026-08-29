import { describe, expect, it } from "vitest";

import { GET } from "./route";

// --------------------------------------------------------------------------
// El endpoint que el navegador consulta para saber si el servidor cambió.
//
// Es PÚBLICO por necesidad —lo consulta una pestaña que puede haber perdido la
// sesión—, así que cada dato de más es superficie regalada.
// --------------------------------------------------------------------------
describe("GET /api/version", () => {
  // CASO K — una respuesta cacheada seguiría afirmando la versión vieja justo
  // después de un despliegue, que es el único momento en que esto sirve.
  it("prohíbe el cacheo", () => {
    const response = GET();

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("devuelve SOLO la versión, sin nada más", async () => {
    const body: unknown = await GET().json();

    expect(Object.keys(body as object)).toEqual(["version"]);
    expect(typeof (body as { version: unknown }).version).toBe("string");
  });

  it("no filtra hostname, rutas ni variables de entorno", async () => {
    const texto = JSON.stringify(await GET().json());

    for (const filtrado of ["DATABASE_URL", "AUTH_SECRET", "localhost", "/app"]) {
      expect(texto).not.toContain(filtrado);
    }
  });
});
