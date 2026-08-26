import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import { SkuIdentityError } from "@/server/domain/catalog/sku-identity";
import {
  applyOrionLink,
  SkuConcurrencyError,
} from "@/server/repositories/sku-review.repository";
import {
  linkOrionCode,
  linkOrionCodeAtCapture,
  onboardProvisionalSku,
} from "@/server/services/sku-onboarding.service";

// El vínculo con el código Orion y su auditoría entran en la MISMA transacción,
// igual que el alta. Y la versión de identidad que llega es la que VIO el
// operador en pantalla: si otro vinculó mientras tanto, este pierde.

const BODEGA = { id: "", role: "BODEGA" as const };
const OPERADOR = { id: "", role: "OPERADOR" as const };
const SUPERVISOR = { id: "", role: "SUPERVISOR" as const };

let seq = 0;
function nextCommandKey(): string {
  seq += 1;
  return `cmd-link-${seq}-${Date.now()}`;
}
function nextOrionCode(): string {
  seq += 1;
  return `770200${String(seq).padStart(7, "0")}`;
}

async function newProduct(name: string) {
  return onboardProvisionalSku({
    actor: BODEGA,
    name,
    unit: "unidad",
    commandKey: nextCommandKey(),
  });
}

beforeAll(async () => {
  const bodega = await prisma.user.create({
    data: { email: `link-bodega-${Date.now()}@test.local`, name: "Bodega", role: "BODEGA" },
  });
  const supervisor = await prisma.user.create({
    data: {
      email: `link-supervisor-${Date.now()}@test.local`,
      name: "Supervisor",
      role: "SUPERVISOR",
    },
  });
  BODEGA.id = bodega.id;
  SUPERVISOR.id = supervisor.id;
});

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { entity: "Product" } });
  await prisma.product.deleteMany({ where: { skuStatus: { not: null } } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [BODEGA.id, SUPERVISOR.id] } } });
});

describe("linkOrionCode", () => {
  it("vincula el código y deja la auditoría en la misma transacción", async () => {
    const product = await newProduct("Ibuprofeno 400mg");
    const orionCode = nextOrionCode();

    const linked = await linkOrionCode({
      actor: BODEGA,
      identity: { internalSku: product.internalSku },
      orionCode,
      intent: "LINK",
      expectedVersion: product.identityVersion,
    });

    expect(linked.orionCode).toBe(orionCode);
    expect(linked.skuStatus).toBe("CONFIRMED");
    expect(linked.identityVersion).toBe(product.identityVersion + 1);

    const audit = await prisma.auditLog.findFirst({
      where: { entity: "Product", entityId: product.id, action: AUDIT_ACTIONS.SKU_ORION_LINK },
    });
    expect(audit?.userId).toBe(BODEGA.id);
  });

  // Si no se puede dejar rastro del vínculo, no hay vínculo.
  it("revierte el vínculo entero cuando la auditoría falla", async () => {
    const product = await newProduct("Amoxicilina 500mg");

    const failure = await linkOrionCode(
      {
        actor: BODEGA,
        identity: { internalSku: product.internalSku },
        orionCode: nextOrionCode(),
        intent: "LINK",
        expectedVersion: product.identityVersion,
      },
      {
        writeAudit: async () => {
          throw new Error("auditoría caída");
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const after = await prisma.product.findUnique({ where: { id: product.id } });
    expect(after?.orionCode).toBeNull();
    expect(after?.identityVersion).toBe(product.identityVersion);
  });

  it("no vincula nada cuando el actor no está autorizado", async () => {
    const product = await newProduct("Dipirona");

    const failure = await linkOrionCode({
      actor: OPERADOR,
      identity: { internalSku: product.internalSku },
      orionCode: nextOrionCode(),
      intent: "LINK",
      expectedVersion: product.identityVersion,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SkuIdentityError);
    expect((failure as SkuIdentityError).code).toBe("FORBIDDEN_ACTOR");
    expect((await prisma.product.findUnique({ where: { id: product.id } }))?.orionCode).toBeNull();
  });

  // La versión que llega es la que mostró la pantalla. Si otro vinculó
  // mientras tanto, este operador NO pisa: se entera y recarga.
  it("pierde la carrera cuando otro operador vinculó primero", async () => {
    const product = await newProduct("Omeprazol");
    const orionCode = nextOrionCode();
    const input = {
      actor: BODEGA,
      identity: { internalSku: product.internalSku },
      orionCode,
      intent: "LINK" as const,
      expectedVersion: product.identityVersion,
    };

    const results = await Promise.allSettled([linkOrionCode(input), linkOrionCode(input)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(SkuConcurrencyError);
    // Un solo vínculo, un solo rastro: el que perdió no auditó nada.
    expect(
      await prisma.auditLog.count({
        where: { entityId: product.id, action: AUDIT_ACTIONS.SKU_ORION_LINK },
      }),
    ).toBe(1);
  });

  it("rechaza una identidad que no existe", async () => {
    const failure = await linkOrionCode({
      actor: BODEGA,
      identity: { internalSku: "PRV-0000000000000000000000" },
      orionCode: nextOrionCode(),
      intent: "LINK",
      expectedVersion: 0,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SkuIdentityError);
    expect((failure as SkuIdentityError).code).toBe("UNKNOWN_SKU");
  });

  it("rechaza tomar un código que ya tiene otro producto", async () => {
    const holder = await newProduct("Cetirizina vieja");
    const target = await newProduct("Cetirizina nueva");
    const orionCode = nextOrionCode();
    await linkOrionCode({
      actor: BODEGA,
      identity: { internalSku: holder.internalSku },
      orionCode,
      intent: "LINK",
      expectedVersion: holder.identityVersion,
    });

    const conflict = await linkOrionCode({
      actor: BODEGA,
      identity: { internalSku: target.internalSku },
      orionCode,
      intent: "LINK",
      expectedVersion: target.identityVersion,
    }).catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(SkuIdentityError);
    expect((conflict as SkuIdentityError).code).toBe("ORION_CONFLICT");
  });
});

describe("linkOrionCode · remapeo", () => {
  // Mudar identidad deja rastro en LOS DOS productos: quien audite el que
  // perdió el código tiene que poder ver por qué lo perdió.
  it("muda el código y audita el producto que lo pierde y el que lo recibe", async () => {
    const holder = await newProduct("Enalapril viejo");
    const target = await newProduct("Enalapril nuevo");
    const orionCode = nextOrionCode();
    const linked = await linkOrionCode({
      actor: BODEGA,
      identity: { internalSku: holder.internalSku },
      orionCode,
      intent: "LINK",
      expectedVersion: holder.identityVersion,
    });
    await prisma.auditLog.deleteMany({ where: { entity: "Product" } });

    const relinked = await linkOrionCode({
      actor: BODEGA,
      identity: { internalSku: target.internalSku },
      orionCode,
      intent: "RELINK",
      expectedVersion: target.identityVersion,
      holderExpectedVersion: linked.identityVersion,
    });

    expect(relinked.orionCode).toBe(orionCode);
    expect((await prisma.product.findUnique({ where: { id: holder.id } }))?.orionCode).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { entityId: holder.id, action: AUDIT_ACTIONS.SKU_ORION_RELEASE },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { entityId: target.id, action: AUDIT_ACTIONS.SKU_ORION_RELINK },
      }),
    ).toBe(1);
  });

  it("no escribe ni audita cuando el vínculo ya existe", async () => {
    const product = await newProduct("Atorvastatina");
    const orionCode = nextOrionCode();
    const linked = await linkOrionCode({
      actor: BODEGA,
      identity: { internalSku: product.internalSku },
      orionCode,
      intent: "LINK",
      expectedVersion: product.identityVersion,
    });
    await prisma.auditLog.deleteMany({ where: { entity: "Product" } });

    const again = await linkOrionCode({
      actor: BODEGA,
      identity: { internalSku: product.internalSku },
      orionCode,
      intent: "LINK",
      expectedVersion: linked.identityVersion,
    });

    expect(again.identityVersion).toBe(linked.identityVersion);
    expect(await prisma.auditLog.count({ where: { entity: "Product" } })).toBe(0);
  });
});

// --------------------------------------------------------------------------
// La CARRERA que descubrió la revisión del 20/8/2026.
//
// `linkOrionCode` lee al `holder` del código FUERA de la transacción. Si dos
// operadores vinculan el MISMO código a productos DISTINTOS a la vez, los dos
// leen `holder = null`, los dos planean LINK, y los dos pasan su propio
// compare-and-set —que solo mira su propia fila—. Al segundo lo frena el
// `@unique` de la base, no la aplicación.
//
// Sin traducir ese P2002, el que pierde recibe el mensaje genérico "intentá de
// nuevo" para algo que NUNCA va a funcionar. Tiene que recibir ORION_CONFLICT,
// que es lo que de verdad pasó.
//
// Se ejercita `applyOrionLink` directamente con un plan LINK: es exactamente
// el estado en el que la carrera deja al segundo escritor —plan ya decidido
// sobre una lectura que quedó vieja—, y hacerlo así lo vuelve determinista.
// --------------------------------------------------------------------------
describe("linkOrionCode · la carrera por el mismo código", () => {
  it("traduce el choque contra el unique de la base, en vez de dejarlo escapar crudo", async () => {
    const orionCode = nextOrionCode();
    const ganador = await newProduct("El que llegó primero");
    const perdedor = await newProduct("El que llegó tarde");

    await linkOrionCode({
      actor: BODEGA,
      identity: { productId: ganador.id },
      orionCode,
      intent: "LINK",
      expectedVersion: ganador.identityVersion,
    });

    // El plan que la carrera dejó armado: LINK, sobre una lectura ya vieja.
    const fallo = await applyOrionLink(
      { action: "LINK", productId: perdedor.id, orionCode },
      { expectedVersion: perdedor.identityVersion },
    ).catch((error: unknown) => error);

    expect(fallo).toBeInstanceOf(SkuIdentityError);
    expect((fallo as SkuIdentityError).code).toBe("ORION_CONFLICT");

    // Y el código sigue donde estaba: la base no se dejó pisar.
    const intacto = await prisma.product.findUniqueOrThrow({ where: { id: ganador.id } });
    expect(intacto.orionCode).toBe(orionCode);
    const sinCodigo = await prisma.product.findUniqueOrThrow({ where: { id: perdedor.id } });
    expect(sinCodigo.orionCode).toBeNull();
  });
});

describe("linkOrionCodeAtCapture", () => {
  it("links with the capture authority and records the complete atomic audit", async () => {
    const product = await newProduct("Capture-only product");
    const orionCode = nextOrionCode();

    const result = await linkOrionCodeAtCapture({
      actor: BODEGA,
      identity: { productId: product.id },
      orionCode,
      expectedVersion: product.identityVersion,
    });

    expect(result).toMatchObject({ status: "LINKED", product: { id: product.id, orionCode } });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: product.id, action: AUDIT_ACTIONS.SKU_ORION_LINK },
    });
    expect(audit).toMatchObject({
      action: AUDIT_ACTIONS.SKU_ORION_LINK,
      module: "productos",
      entity: "Product",
      entityId: product.id,
      userId: BODEGA.id,
      before: { orionCode: null, identityVersion: product.identityVersion },
      after: { orionCode, identityVersion: product.identityVersion + 1 },
    });
  });

  it("does not let an ungranted runtime role write a product or audit", async () => {
    const product = await newProduct("Denied capture product");

    await expect(
      linkOrionCodeAtCapture({
        actor: { id: BODEGA.id, role: "AUDITOR" as never },
        identity: { productId: product.id },
        orionCode: nextOrionCode(),
        expectedVersion: product.identityVersion,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });

    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({
      orionCode: null,
      identityVersion: product.identityVersion,
    });
    expect(
      await prisma.auditLog.count({ where: { entityId: product.id, action: AUDIT_ACTIONS.SKU_ORION_LINK } }),
    ).toBe(0);
  });

  it("returns the existing holder without moving a code", async () => {
    const holder = await newProduct("Existing holder");
    const target = await newProduct("Conflict target");
    const orionCode = nextOrionCode();
    await linkOrionCode({
      actor: BODEGA,
      identity: { productId: holder.id },
      orionCode,
      intent: "LINK",
      expectedVersion: holder.identityVersion,
    });

    const result = await linkOrionCodeAtCapture({
      actor: BODEGA,
      identity: { productId: target.id },
      orionCode,
      expectedVersion: target.identityVersion,
    });

    expect(result).toEqual({ status: "ORION_CONFLICT", holder: { id: holder.id, name: holder.name } });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      orionCode: null,
      identityVersion: target.identityVersion,
    });
  });

  it("ignores a forged RELINK intent because capture only executes LINK", async () => {
    const holder = await newProduct("Forged-intent holder");
    const target = await newProduct("Forged-intent target");
    const orionCode = nextOrionCode();
    await linkOrionCode({
      actor: BODEGA,
      identity: { productId: holder.id },
      orionCode,
      intent: "LINK",
      expectedVersion: holder.identityVersion,
    });

    const result = await linkOrionCodeAtCapture({
      actor: BODEGA,
      identity: { productId: target.id },
      orionCode,
      expectedVersion: target.identityVersion,
      intent: "RELINK",
    } as never);

    expect(result).toEqual({ status: "ORION_CONFLICT", holder: { id: holder.id, name: holder.name } });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: holder.id } })).toMatchObject({ orionCode });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      orionCode: null,
      identityVersion: target.identityVersion,
    });
  });

  it("returns NOOP without audit or writes, and revalidates it after a concurrent change", async () => {
    const product = await newProduct("NOOP target");
    const orionCode = nextOrionCode();
    const linked = await linkOrionCode({
      actor: BODEGA,
      identity: { productId: product.id },
      orionCode,
      intent: "LINK",
      expectedVersion: product.identityVersion,
    });
    await prisma.auditLog.deleteMany({ where: { entityId: product.id } });

    const noop = await linkOrionCodeAtCapture({
      actor: BODEGA,
      identity: { productId: product.id },
      orionCode,
      expectedVersion: linked.identityVersion,
    });
    expect(noop).toMatchObject({ status: "NOOP", product: { identityVersion: linked.identityVersion } });
    expect(await prisma.auditLog.count({ where: { entityId: product.id } })).toBe(0);
  });

  it("rolls back the code and version when the LINK audit fails", async () => {
    const product = await newProduct("Audit rollback target");

    await expect(
      linkOrionCodeAtCapture(
        {
          actor: BODEGA,
          identity: { productId: product.id },
          orionCode: nextOrionCode(),
          expectedVersion: product.identityVersion,
        },
        { writeAudit: async () => { throw new Error("audit unavailable"); } },
      ),
    ).rejects.toThrow("audit unavailable");

    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({
      orionCode: null,
      identityVersion: product.identityVersion,
    });
    expect(
      await prisma.auditLog.count({ where: { entityId: product.id, action: AUDIT_ACTIONS.SKU_ORION_LINK } }),
    ).toBe(0);
  });

  it("revalidates a NOOP after a concurrent FIX instead of returning stale success", async () => {
    const product = await newProduct("Concurrent NOOP target");
    const originalCode = nextOrionCode();
    const linked = await linkOrionCode({
      actor: BODEGA,
      identity: { productId: product.id },
      orionCode: originalCode,
      intent: "LINK",
      expectedVersion: product.identityVersion,
    });
    await prisma.auditLog.deleteMany({ where: { entityId: product.id } });

    let allowNoop!: () => void;
    const noopReady = new Promise<void>((resolve) => { allowNoop = resolve; });
    let observedNoop!: () => void;
    const noopObserved = new Promise<void>((resolve) => { observedNoop = resolve; });
    const attempt = linkOrionCodeAtCapture(
      {
        actor: BODEGA,
        identity: { productId: product.id },
        orionCode: originalCode,
        expectedVersion: linked.identityVersion,
      },
      {
        beforeApply: async () => {
          observedNoop();
          await noopReady;
        },
      },
    );
    await noopObserved;
    await linkOrionCode({
      actor: SUPERVISOR,
      identity: { productId: product.id },
      orionCode: nextOrionCode(),
      intent: "FIX",
      expectedVersion: linked.identityVersion,
    });
    allowNoop();

    await expect(attempt).rejects.toBeInstanceOf(SkuConcurrencyError);
    expect(await prisma.auditLog.count({ where: { entityId: product.id } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { entityId: product.id, action: AUDIT_ACTIONS.SKU_ORION_LINK } }),
    ).toBe(0);
  });

  it("forces both contenders past pre-read and returns the P2002 winner as holder", async () => {
    const first = await newProduct("Race contender one");
    const second = await newProduct("Race contender two");
    const orionCode = nextOrionCode();
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let bothReady!: () => void;
    const bothArrived = new Promise<void>((resolve) => { bothReady = resolve; });
    const beforeApply = async () => {
      arrivals += 1;
      if (arrivals === 2) bothReady();
      await gate;
    };

    const attempts = [first, second].map((product) =>
      linkOrionCodeAtCapture(
        {
          actor: BODEGA,
          identity: { productId: product.id },
          orionCode,
          expectedVersion: product.identityVersion,
        },
        { beforeApply },
      ),
    );
    await bothArrived;
    release();
    const results = await Promise.all(attempts);

    expect(arrivals).toBe(2);
    const winner = results.find((result) => result.status === "LINKED");
    const loser = results.find((result) => result.status === "ORION_CONFLICT");
    expect(winner).toMatchObject({ status: "LINKED", product: { orionCode } });
    expect(loser).toEqual({
      status: "ORION_CONFLICT",
      holder: { id: winner?.product.id, name: winner?.product.name },
    });
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.SKU_ORION_LINK } })).toBe(1);
    const losingProduct = [first, second].find((product) => product.id !== winner?.product.id);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: losingProduct!.id } })).toMatchObject({
      orionCode: null,
      identityVersion: losingProduct!.identityVersion,
    });
  });
});

// --------------------------------------------------------------------------
// Corregir un código Orion mal cargado.
//
// El código se copia a mano desde el ERP, y quien lo copia está en el mostrador
// con un cliente enfrente. Hasta ahora ese error era PERMANENTE: la escritura
// filtra por `orionCode: null`, así que nada podía cambiar un código ya puesto.
//
// Va contra PostgreSQL real y no con dobles porque lo que hay que probar es el
// compare-and-set: que la corrección no pise un código que cambió en el medio,
// y que el `@unique` de la base frene una colisión que la lectura previa no vio.
// --------------------------------------------------------------------------
describe("corrección del código Orion", () => {
  async function linkedProduct(name: string, orionCode: string) {
    const product = await newProduct(name);
    const linked = await linkOrionCode({
      actor: BODEGA,
      identity: { internalSku: product.internalSku },
      orionCode,
      intent: "LINK",
      expectedVersion: product.identityVersion,
    });
    return linked;
  }

  it("cambia el código equivocado y deja rastro del anterior", async () => {
    const malCargado = nextOrionCode();
    const correcto = nextOrionCode();
    const product = await linkedProduct("Losartán 50mg", malCargado);

    const fixed = await linkOrionCode({
      actor: SUPERVISOR,
      identity: { productId: product.id },
      orionCode: correcto,
      intent: "FIX",
      expectedVersion: product.identityVersion,
    });

    expect(fixed.orionCode).toBe(correcto);
    expect(fixed.identityVersion).toBe(product.identityVersion + 1);

    // El rastro tiene que decir de qué código se venía: sin eso, reconciliar
    // contra Orion hacia atrás es imposible, y esa es la única razón real por
    // la que el código valía la pena protegerlo.
    const audit = await prisma.auditLog.findFirst({
      where: { entity: "Product", entityId: product.id, action: AUDIT_ACTIONS.SKU_ORION_FIX },
    });
    expect(audit?.userId).toBe(SUPERVISOR.id);
    expect(audit?.before).toMatchObject({ orionCode: malCargado });
    expect(audit?.after).toMatchObject({ orionCode: correcto });
  });

  it("el vendedor no puede corregir", async () => {
    const product = await linkedProduct("Naproxeno 250mg", nextOrionCode());

    await expect(
      linkOrionCode({
        actor: { id: BODEGA.id, role: "OPERADOR" },
        identity: { productId: product.id },
        orionCode: nextOrionCode(),
        intent: "FIX",
        expectedVersion: product.identityVersion,
      }),
    ).rejects.toBeInstanceOf(SkuIdentityError);
  });

  // La versión que llega es la que vio quien corrige. Si otro tocó la identidad
  // mientras tanto, este pierde: corregir sobre una pantalla vieja escribiría
  // encima de una decisión que no se vio.
  it("rechaza corregir con una versión vencida", async () => {
    const product = await linkedProduct("Omeprazol 20mg", nextOrionCode());

    await expect(
      linkOrionCode({
        actor: SUPERVISOR,
        identity: { productId: product.id },
        orionCode: nextOrionCode(),
        intent: "FIX",
        expectedVersion: product.identityVersion - 1,
      }),
    ).rejects.toBeInstanceOf(SkuConcurrencyError);
  });

  it("rechaza corregir hacia un código que ya tiene otro producto", async () => {
    const ocupado = nextOrionCode();
    await linkedProduct("Metformina 850mg", ocupado);
    const product = await linkedProduct("Enalapril 10mg", nextOrionCode());

    await expect(
      linkOrionCode({
        actor: SUPERVISOR,
        identity: { productId: product.id },
        orionCode: ocupado,
        intent: "FIX",
        expectedVersion: product.identityVersion,
      }),
    ).rejects.toBeInstanceOf(SkuIdentityError);

    // Y el producto queda como estaba: un rechazo no puede dejarlo sin código.
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.orionCode).toBe(product.orionCode);
  });
});

// --------------------------------------------------------------------------
// La autoridad sigue a la ACCIÓN ejecutada, no a la INTENCIÓN pedida.
//
// `planOrionLink` degrada a propósito un `intent: "FIX"` sobre un producto que
// todavía no tiene código: cubre la carrera de que otro operador lo vincule
// mientras el formulario de corrección estaba abierto. Ese paso se conserva.
//
// Pero el efecto de esa degradación es ACUÑAR la identidad canónica, y acuñar
// es una autoridad más angosta que corregir. Si la cerradura se elige por el
// `intent` que mandó el llamador, un SUPERVISOR —que corrige pero NO acuña—
// entra por la puerta de corrección y sale acuñando. El portón queda más ancho
// que la cerradura, que es la dirección peligrosa.
//
// Por eso la autoridad se verifica DESPUÉS de que el plan resuelva, contra
// `plan.action`.
// --------------------------------------------------------------------------
describe("la autoridad sigue a la acción resuelta", () => {
  it("no deja que un actor sin autoridad de acuñación acuñe un código pidiéndolo como corrección", async () => {
    const product = await newProduct("Clonazepam 0.5mg");

    const failure = await linkOrionCode({
      actor: OPERADOR,
      identity: { productId: product.id },
      orionCode: nextOrionCode(),
      intent: "FIX",
      expectedVersion: product.identityVersion,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SkuIdentityError);
    expect((failure as SkuIdentityError).code).toBe("FORBIDDEN_ACTOR");

    // Y no escribió nada: el producto sigue sin identidad canónica.
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.orionCode).toBeNull();
    expect(after.identityVersion).toBe(product.identityVersion);
  });

  // La carrera legítima sigue funcionando para quien SÍ puede acuñar.
  it("deja que bodega vincule aunque haya pedido una corrección", async () => {
    const product = await newProduct("Sertralina 50mg");
    const orionCode = nextOrionCode();

    const linked = await linkOrionCode({
      actor: BODEGA,
      identity: { productId: product.id },
      orionCode,
      intent: "FIX",
      expectedVersion: product.identityVersion,
    });

    expect(linked.orionCode).toBe(orionCode);
    expect(linked.skuStatus).toBe("CONFIRMED");
  });

  it("sigue dejando que supervisión corrija un código ya cargado", async () => {
    const product = await newProduct("Metoprolol 50mg");
    const linked = await linkOrionCode({
      actor: BODEGA,
      identity: { productId: product.id },
      orionCode: nextOrionCode(),
      intent: "LINK",
      expectedVersion: product.identityVersion,
    });
    const correcto = nextOrionCode();

    const fixed = await linkOrionCode({
      actor: SUPERVISOR,
      identity: { productId: product.id },
      orionCode: correcto,
      intent: "FIX",
      expectedVersion: linked.identityVersion,
    });

    expect(fixed.orionCode).toBe(correcto);
  });
});
