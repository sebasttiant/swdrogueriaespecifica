import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import { SkuIdentityError } from "@/server/domain/catalog/sku-identity";
import {
  onboardProvisionalSku,
  SkuCommandConflictError,
} from "@/server/services/sku-onboarding.service";

// La decisión de negocio que fija este archivo: en el alta de identidad, la
// auditoría va DENTRO de la misma transacción. Si no se puede dejar rastro, no
// se acuña la identidad. Solo se puede probar contra PostgreSQL real, porque lo
// que se verifica es el ROLLBACK.

let commandSeq = 0;
/** Cada alta llega con la clave de SU intento. */
function nextCommandKey(): string {
  commandSeq += 1;
  return `cmd-sku-${commandSeq}-${Date.now()}`;
}

const BODEGA = { id: "", role: "BODEGA" as const };
const SUPERVISOR = { id: "", role: "SUPERVISOR" as const };

beforeAll(async () => {
  const bodega = await prisma.user.create({
    data: { email: `bodega-${Date.now()}@test.local`, name: "Bodega", role: "BODEGA" },
  });
  const supervisor = await prisma.user.create({
    data: {
      email: `supervisor-${Date.now()}@test.local`,
      name: "Supervisor",
      role: "SUPERVISOR",
    },
  });
  BODEGA.id = bodega.id;
  SUPERVISOR.id = supervisor.id;
});

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { entity: "Product" } });
  await prisma.product.deleteMany({ where: { skuStatus: "PROVISIONAL_REVIEW" } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [BODEGA.id, SUPERVISOR.id] } } });
});

describe("onboardProvisionalSku", () => {
  it("acuña la identidad y deja el rastro de auditoría", async () => {
    const product = await onboardProvisionalSku({
      actor: BODEGA,
      name: "Ibuprofeno 400mg",
      unit: "unidad",
      commandKey: nextCommandKey(),
    });

    const audit = await prisma.auditLog.findFirst({
      where: { entity: "Product", entityId: product.id },
    });

    expect(audit?.action).toBe(AUDIT_ACTIONS.SKU_ONBOARD);
    expect(audit?.userId).toBe(BODEGA.id);
    expect(audit?.result).toBe("SUCCESS");
  });

  // El corazón de la decisión: si la auditoría falla, NO queda el producto.
  // Un producto acuñado sin rastro es un producto que después nadie explica.
  it("revierte el alta completa cuando la auditoría falla", async () => {
    const before = await prisma.product.count();

    const failure = await onboardProvisionalSku(
      {
        actor: BODEGA,
        name: "Amoxicilina 500mg",
        unit: "unidad",
        commandKey: nextCommandKey(),
      },
      {
        writeAudit: async () => {
          throw new Error("auditoría caída");
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(await prisma.product.count()).toBe(before);
  });

  it("no acuña nada cuando el actor no está autorizado", async () => {
    const before = await prisma.product.count();

    const failure = await onboardProvisionalSku({
      actor: SUPERVISOR,
      name: "Dipirona",
      unit: "unidad",
      commandKey: nextCommandKey(),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SkuIdentityError);
    expect((failure as SkuIdentityError).code).toBe("FORBIDDEN_ACTOR");
    expect(await prisma.product.count()).toBe(before);
    expect(await prisma.auditLog.count({ where: { entity: "Product" } })).toBe(0);
  });

  // Una colisión de SKU ABORTA la transacción en PostgreSQL: el reintento tiene
  // que abrir una transacción nueva, no seguir dentro de la que ya falló. Si
  // esto estuviera mal, el segundo alta no escribiría nada y nadie se enteraría.
  it("reintenta la colisión en una transacción nueva y deja auditoría", async () => {
    const at = new Date("2026-08-15T03:00:00Z").getTime();
    const bytes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let call = 0;

    const first = await onboardProvisionalSku(
      {
        actor: BODEGA,
        name: "Cetirizina",
        unit: "unidad",
        commandKey: nextCommandKey(),
      },
      { generation: { now: () => at, randomness: () => new Uint8Array(bytes) } },
    );

    const second = await onboardProvisionalSku(
      {
        actor: BODEGA,
        name: "Cetirizina",
        unit: "unidad",
        commandKey: nextCommandKey(),
      },
      {
        generation: {
          now: () => at,
          randomness: () => {
            call += 1;
            // El primer intento repite exactamente el SKU de `first`.
            return new Uint8Array(call <= 1 ? bytes : bytes.map((byte) => byte + call));
          },
        },
      },
    );

    expect(second.internalSku).not.toBe(first.internalSku);
    expect(
      await prisma.auditLog.count({ where: { entity: "Product", entityId: second.id } }),
    ).toBe(1);
  });
});

describe("idempotencia del comando de alta", () => {
  // El operador cuyo navegador se colgó y le dio otra vez a "guardar" no puede
  // terminar con dos productos distintos para la misma mercadería.
  it("un reintento con la misma clave devuelve el mismo producto", async () => {
    const input = {
      actor: BODEGA,
      name: "Loratadina",
      unit: "unidad",
      commandKey: nextCommandKey(),
    };

    const first = await onboardProvisionalSku(input);
    const replay = await onboardProvisionalSku(input);

    expect(replay.id).toBe(first.id);
    expect(replay.internalSku).toBe(first.internalSku);
    expect(
      await prisma.product.count({ where: { identityCommandKey: input.commandKey } }),
    ).toBe(1);
  });

  it("el reintento no duplica el rastro de auditoría", async () => {
    const input = {
      actor: BODEGA,
      name: "Ranitidina",
      unit: "unidad",
      commandKey: nextCommandKey(),
    };

    const product = await onboardProvisionalSku(input);
    await onboardProvisionalSku(input);

    expect(
      await prisma.auditLog.count({ where: { entity: "Product", entityId: product.id } }),
    ).toBe(1);
  });

  // La misma clave con OTRO contenido no es un reintento: es un error del
  // llamador. Devolverle el producto anterior lo dejaría creyendo que acuñó
  // algo que nunca acuñó.
  it("rechaza la misma clave con un contenido distinto", async () => {
    const commandKey = nextCommandKey();
    await onboardProvisionalSku({
      actor: BODEGA,
      name: "Omeprazol",
      unit: "unidad",
      commandKey,
    });

    const conflict = await onboardProvisionalSku({
      actor: BODEGA,
      name: "Omeprazol 20mg",
      unit: "unidad",
      commandKey,
    }).catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(SkuCommandConflictError);
    expect(await prisma.product.count({ where: { identityCommandKey: commandKey } })).toBe(
      1,
    );
  });

  // Dos altas simultáneas con la misma clave: el índice único es el que decide,
  // y el que pierde la carrera recibe el producto del que ganó.
  it("dos intentos simultáneos con la misma clave acuñan un solo producto", async () => {
    const input = {
      actor: BODEGA,
      name: "Atorvastatina",
      unit: "unidad",
      commandKey: nextCommandKey(),
    };

    const results = await Promise.all([
      onboardProvisionalSku(input),
      onboardProvisionalSku(input),
    ]);

    expect(results[0]?.id).toBe(results[1]?.id);
    expect(
      await prisma.product.count({ where: { identityCommandKey: input.commandKey } }),
    ).toBe(1);
  });
});
