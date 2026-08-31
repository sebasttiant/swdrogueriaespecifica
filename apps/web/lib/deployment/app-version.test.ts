import { describe, expect, it, vi } from "vitest";

import { assertVersionConfigured, isStale } from "./app-version";

// --------------------------------------------------------------------------
// Qué cuenta como desfase, y sobre todo qué NO.
//
// Un falso positivo acá no es cosmético: bloquea Facturar, Entregar y Cancelar
// en todo el mostrador. Por eso la duda siempre se resuelve a favor de dejar
// operar.
// --------------------------------------------------------------------------
describe("isStale", () => {
  it("marca desfase cuando los builds difieren", () => {
    expect(isStale("abc1234", "def5678")).toBe(true);
  });

  it("no marca desfase con el mismo build", () => {
    expect(isStale("abc1234", "abc1234")).toBe(false);
  });

  // `unknown` es "no sé", no "cambió". En desarrollo no hay despliegue del que
  // desfasarse; y si la variable no llegara al build por un error de
  // configuración, callarse es infinitamente mejor que bloquear la operación
  // entera por un dato que falta.
  it("un 'unknown' del cliente NUNCA marca desfase", () => {
    expect(isStale("unknown", "def5678")).toBe(false);
  });

  it("un 'unknown' del servidor NUNCA marca desfase", () => {
    expect(isStale("abc1234", "unknown")).toBe(false);
  });

  it("dos 'unknown' —desarrollo— no molestan", () => {
    expect(isStale("unknown", "unknown")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Una imagen de producción sin versión no es un detalle menor: `isStale` trata
// `unknown` como "no sé" y nunca marca desfase, así que un despliegue mal
// armado se vería idéntico a uno sano — hasta que alguien facture desde una
// pestaña vieja. Falla temprano, donde todavía se puede corregir.
// --------------------------------------------------------------------------
describe("assertVersionConfigured", () => {
  it("falla en producción cuando la versión no llegó al build", () => {
    expect(() => assertVersionConfigured("unknown", "production")).toThrow(
      /NEXT_PUBLIC_APP_VERSION/,
    );
  });

  it("no molesta en producción con una versión real", () => {
    expect(() => assertVersionConfigured("abc1234", "production")).not.toThrow();
  });

  it("no aplica en desarrollo: no hay despliegue del que desfasarse", () => {
    expect(() => assertVersionConfigured("unknown", "development")).not.toThrow();
  });

  it("tampoco en las pruebas", () => {
    expect(() => assertVersionConfigured("unknown", "test")).not.toThrow();
  });
});

// --------------------------------------------------------------------------
// Las cuatro superficies tienen que decir EXACTAMENTE lo mismo, porque el guard
// compara dos de ellas: si el bundle y el endpoint salieran de fuentes
// distintas, el desfase sería un falso positivo permanente o un falso negativo
// permanente, y las dos posibilidades son peores que no tener guard.
// --------------------------------------------------------------------------
describe("una sola fuente de versión", () => {
  it("cliente, servidor, endpoint y deploymentId comparten el valor", async () => {
    const anterior = process.env.NEXT_PUBLIC_APP_VERSION;
    process.env.NEXT_PUBLIC_APP_VERSION = "sha-conocido";
    vi.resetModules();

    const { APP_VERSION: enModulo } = await import("./app-version");
    const { GET } = await import("@/app/api/version/route");
    const { default: nextConfig } = await import("@/next.config");
    const cuerpo = (await GET().json()) as { version: string };

    // El módulo es la fuente única: el bundle del cliente y el del servidor lo
    // importan igual, así que basta comprobar que las otras dos superficies
    // salen de ahí.
    expect(enModulo).toBe("sha-conocido");
    expect(cuerpo.version).toBe(enModulo);
    expect(nextConfig.deploymentId).toBe(enModulo);

    process.env.NEXT_PUBLIC_APP_VERSION = anterior;
    vi.resetModules();
  });
});

// --------------------------------------------------------------------------
// Desarrollo se NOMBRA. Dejarlo en `unknown` obliga a averiguar, cada vez, si
// falta configuración o si simplemente es local — y ese es justo el momento en
// que alguien decide que el guard estorba.
// --------------------------------------------------------------------------
describe("versión fuera de producción", () => {
  it("'development' nunca compara como desfase", () => {
    expect(isStale("development", "abc1234")).toBe(false);
    expect(isStale("abc1234", "development")).toBe(false);
    expect(isStale("development", "development")).toBe(false);
  });

  it("no hace fallar el arranque en desarrollo", () => {
    expect(() =>
      assertVersionConfigured("development", "development"),
    ).not.toThrow();
  });

  // Producción con "development" es una imagen construida sin el build-arg:
  // se ve sana y tiene la protección apagada.
  it("pero en producción sigue siendo una configuración inválida", () => {
    expect(() => assertVersionConfigured("unknown", "production")).toThrow();
  });
});
