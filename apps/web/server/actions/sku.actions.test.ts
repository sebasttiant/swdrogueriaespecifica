import { beforeEach, describe, expect, it, vi } from "vitest";

// Aislamos la action: el foco es el GUARD y el mapeo de errores, no la regla
// de identidad —esa ya está probada contra PostgreSQL real en
// `tests/postgres/orion-link.pg.test.ts` y no se vuelve a probar acá—.
//
// El repositorio se mockea porque importar el de verdad arrastra el singleton
// de Prisma, que exige `AUTH_SECRET`. Pero `SkuConcurrencyError` se usa con
// `instanceof`, así que el mock tiene que exponer una clase REAL: la action y
// el test la resuelven del mismo módulo mockeado, y por eso el `instanceof`
// sigue significando algo.
const {
  checkCapability,
  linkOrionCode,
  auditContextFromHeaders,
  revalidatePath,
} = vi.hoisted(() => ({
  checkCapability: vi.fn(),
  linkOrionCode: vi.fn(),
  auditContextFromHeaders: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/auth/require-role", () => ({ checkCapability }));
vi.mock("@/server/services/sku-onboarding.service", () => ({ linkOrionCode }));
vi.mock("@/server/services/audit.service", () => ({ auditContextFromHeaders }));
vi.mock("@/server/repositories/sku-review.repository", () => ({
  SkuConcurrencyError: class SkuConcurrencyError extends Error {},
}));

import {
  SKU_IDENTITY_CONCURRENCY_MESSAGE,
  SKU_IDENTITY_MESSAGES,
} from "@/features/productos/sku-identity-messages";
import { SkuIdentityError } from "@/server/domain/catalog/sku-identity";
import { SkuConcurrencyError } from "@/server/repositories/sku-review.repository";

import { fixOrionCodeAction, linkOrionCodeAction } from "./sku.actions";

const PREV = { error: null, ok: false };
const session = { user: { id: "u1", email: "a@x.com", name: "A", role: "ADMIN" } };

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

const VALID = { expectedVersion: "0", orionCode: "7702057012345", productId: "p1" };

beforeEach(() => {
  vi.clearAllMocks();
  checkCapability.mockResolvedValue({ ok: true, session });
  auditContextFromHeaders.mockResolvedValue({});
  linkOrionCode.mockResolvedValue({ id: "p1" });
});

describe("linkOrionCodeAction · guard", () => {
  it("pasa exactamente por checkCapability('canManageProducts') y manda intent LINK", async () => {
    await linkOrionCodeAction(PREV, form(VALID));

    expect(checkCapability).toHaveBeenCalledOnce();
    expect(checkCapability).toHaveBeenCalledWith("canManageProducts");
    expect(linkOrionCode).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "LINK" }),
    );
  });

  it("verifica el permiso ANTES de mirar lo que vino en el formulario", async () => {
    const order: string[] = [];
    checkCapability.mockImplementation(() => {
      order.push("guard");
      return Promise.resolve({ ok: true, session });
    });
    linkOrionCode.mockImplementation(() => {
      order.push("service");
      return Promise.resolve({ id: "p1" });
    });

    await linkOrionCodeAction(PREV, form(VALID));

    expect(order).toEqual(["guard", "service"]);
  });
});

describe("fixOrionCodeAction · contrato", () => {
  it("pasa exactamente por checkCapability('canFixProductIdentity') y manda intent FIX", async () => {
    await fixOrionCodeAction(PREV, form(VALID));

    expect(checkCapability).toHaveBeenCalledOnce();
    expect(checkCapability).toHaveBeenCalledWith("canFixProductIdentity");
    expect(linkOrionCode).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "FIX" }),
    );
  });

  it.each([
    ["NO_SESSION", /sesión/i],
    ["INACTIVE", /inactivo/i],
    ["FORBIDDEN", /permiso/i],
  ] as const)(
    "devuelve un error accionable para %s sin servicio ni revalidación",
    async (reason, expectedMessage) => {
      checkCapability.mockResolvedValue({ ok: false, reason });

      const state = await fixOrionCodeAction(PREV, form(VALID));

      expect(state.ok).toBe(false);
      expect(state.error).toMatch(expectedMessage);
      expect(linkOrionCode).not.toHaveBeenCalled();
      expect(auditContextFromHeaders).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );
});

describe("linkOrionCodeAction · qué le manda al servicio", () => {
  it("manda una sola identidad exacta y nunca RELINK", async () => {
    await linkOrionCodeAction(PREV, form(VALID));

    const [input] = linkOrionCode.mock.calls[0] as [Record<string, unknown>];
    expect(input.identity).toEqual({ productId: "p1" });
    expect(input.intent).toBe("LINK");
    expect(input.expectedVersion).toBe(0);
    expect(input.orionCode).toBe("7702057012345");
    expect(input.actor).toEqual({ id: "u1", role: "ADMIN" });
  });

  it("no llama al servicio cuando el formulario no valida", async () => {
    const state = await linkOrionCodeAction(PREV, form({ ...VALID, orionCode: "A B" }));

    expect(linkOrionCode).not.toHaveBeenCalled();
    expect(state.ok).toBe(false);
    // El mensaje del schema, que explica QUÉ está mal, no uno genérico.
    expect(state.error).toContain("espacios");
  });
});

describe("linkOrionCodeAction · errores", () => {
  it("traduce perder la carrera a su propio mensaje, no al genérico", async () => {
    linkOrionCode.mockRejectedValue(new SkuConcurrencyError());

    const state = await linkOrionCodeAction(PREV, form(VALID));

    expect(state).toEqual({ error: SKU_IDENTITY_CONCURRENCY_MESSAGE, ok: false });
  });

  it("traduce cada código del dominio a su mensaje", async () => {
    linkOrionCode.mockRejectedValue(new SkuIdentityError("ORION_CONFLICT"));

    const state = await linkOrionCodeAction(PREV, form(VALID));

    expect(state).toEqual({ error: SKU_IDENTITY_MESSAGES.ORION_CONFLICT, ok: false });
  });

  it("no le filtra al operador un error que no sabemos nombrar", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    linkOrionCode.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const state = await linkOrionCodeAction(PREV, form(VALID));

    expect(state).toEqual({
      error: "No se pudo guardar el código. Intentá de nuevo; si sigue, avisá a soporte.",
      ok: false,
    });
    expect(state.error).not.toContain("connection");
    spy.mockRestore();
  });

  it("no revalida ninguna pantalla cuando el vínculo falló", async () => {
    linkOrionCode.mockRejectedValue(new SkuIdentityError("UNKNOWN_SKU"));

    await linkOrionCodeAction(PREV, form(VALID));

    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("linkOrionCodeAction · éxito", () => {
  it("revalida el detalle y el listado, y avisa que salió bien", async () => {
    const state = await linkOrionCodeAction(PREV, form(VALID));

    expect(state).toEqual({ error: null, ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/productos/p1");
    expect(revalidatePath).toHaveBeenCalledWith("/productos");
  });

  it("no audita por su cuenta: el asiento lo escribe el servicio en la misma transacción", async () => {
    await linkOrionCodeAction(PREV, form(VALID));

    const [input] = linkOrionCode.mock.calls[0] as [Record<string, unknown>];
    expect(input.context).toBeDefined();
    expect(auditContextFromHeaders).toHaveBeenCalledWith("u1");
  });
});

// --------------------------------------------------------------------------
// Hallazgos de la revisión del 20/8/2026.
// --------------------------------------------------------------------------
describe("linkOrionCodeAction · después de escribir", () => {
  it("un refresco de caché caído NO convierte en error un vínculo que sí se escribió", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    revalidatePath.mockImplementation(() => {
      throw new Error("revalidate exploded");
    });

    const state = await linkOrionCodeAction(PREV, form(VALID));

    // El código quedó puesto en la base: decirle "no se pudo" lo mandaría a
    // reintentar sobre una identidad que ya existe.
    expect(state).toEqual({ error: null, ok: true });
    spy.mockRestore();
  });
});

describe("linkOrionCodeAction · qué queda para soporte", () => {
  it("loguea qué se intentaba y quién, también cuando el rechazo es esperado", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    linkOrionCode.mockRejectedValue(new SkuIdentityError("ORION_CONFLICT"));

    await linkOrionCodeAction(PREV, form(VALID));

    expect(spy).toHaveBeenCalledOnce();
    const registrado = JSON.stringify(spy.mock.calls[0]);
    expect(registrado).toContain("p1");
    expect(registrado).toContain("7702057012345");
    expect(registrado).toContain("u1");
    spy.mockRestore();
  });

  it("deja rastro de la carrera perdida, que es lo que hay que poder contar", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    linkOrionCode.mockRejectedValue(new SkuConcurrencyError());

    await linkOrionCodeAction(PREV, form(VALID));

    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.stringify(spy.mock.calls[0])).toContain("7702057012345");
    spy.mockRestore();
  });
});
