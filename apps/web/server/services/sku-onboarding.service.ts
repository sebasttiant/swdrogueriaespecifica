import { createHash } from "node:crypto";

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import type { SessionRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import type { Product } from "@/lib/generated/prisma/client";
import {
  assertAttemptWithinBudget,
  assertCanFixSkuIdentity,
  assertCanOnboardSku,
  assertIdentityMatches,
  normalizeOrionCode,
  planOrionLink,
  type IdentityInput,
  type SkuIdentityRecord,
} from "@/server/domain/catalog/sku-identity";
import {
  applyOrionLink,
  findProductByIdentity,
  findProductByIdentityCommandKey,
  insertProvisionalProduct,
  isUniqueViolation,
  mintInternalSku,
  type SkuGenerationDeps,
} from "@/server/repositories/sku-review.repository";
import type { AuditContext } from "@/server/services/audit.service";
import {
  recordAuditInTransaction,
  type TransactionalAuditWriter,
} from "@/server/services/transactional-audit.service";

// --------------------------------------------------------------------------
// Alta de identidad de producto (server-only).
//
// Tres garantías, y las tres se prueban contra PostgreSQL real:
//
//  1. Solo un actor autorizado acuña identidad.
//  2. El producto y su auditoría entran en la MISMA transacción. Si no se puede
//     dejar rastro, no se acuña la identidad. Decisión del dueño acotada a este
//     flujo (ver `transactional-audit.service.ts`).
//  3. Un reintento con la misma clave de comando devuelve el mismo producto en
//     lugar de acuñar otro. La misma clave con OTRO contenido es un error.
// --------------------------------------------------------------------------

export type SkuOnboardingActor = {
  id: string;
  role: SessionRole;
};

/** La clave del comando ya se usó para un contenido distinto. */
export class SkuCommandConflictError extends Error {
  constructor() {
    super("identity command key was already used for a different payload");
    this.name = "SkuCommandConflictError";
  }
}

export type OnboardProvisionalSkuInput = {
  actor: SkuOnboardingActor;
  name: string;
  unit: string;
  minStock?: number;
  reorderQty?: number;
  /** Clave del INTENTO del operador, no del producto. */
  commandKey: string;
  context?: AuditContext;
};

export type OnboardProvisionalSkuDeps = {
  generation?: SkuGenerationDeps;
  /** Inyectable para poder probar que una auditoría caída revierte el alta. */
  writeAudit?: TransactionalAuditWriter;
};

/**
 * Huella del contenido semántico del comando. JSON con las claves ordenadas
 * para que el mismo contenido dé siempre la misma huella.
 */
function fingerprintOf(input: OnboardProvisionalSkuInput): string {
  const payload = {
    actorId: input.actor.id,
    minStock: input.minStock ?? 0,
    name: input.name.trim(),
    reorderQty: input.reorderQty ?? 0,
    unit: input.unit,
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function replayOrConflict(stored: Product, fingerprint: string): Product {
  if (stored.identityCommandFingerprint !== fingerprint) {
    throw new SkuCommandConflictError();
  }
  return stored;
}

export async function onboardProvisionalSku(
  input: OnboardProvisionalSkuInput,
  deps: OnboardProvisionalSkuDeps = {},
): Promise<Product> {
  assertCanOnboardSku(input.actor.role);

  const fingerprint = fingerprintOf(input);
  const known = await findProductByIdentityCommandKey(input.commandKey);
  if (known) return replayOrConflict(known, fingerprint);

  const writeAudit = deps.writeAudit ?? recordAuditInTransaction;

  // Un intento por transacción: en PostgreSQL la violación del índice único
  // aborta la transacción entera, así que reintentar adentro de la que ya falló
  // no escribiría nada. Cada intento abre la suya.
  for (let attempt = 1; ; attempt += 1) {
    assertAttemptWithinBudget(attempt);

    const internalSku = mintInternalSku(deps.generation);

    try {
      return await prisma.$transaction(async (tx) => {
        const product = await insertProvisionalProduct(tx, {
          name: input.name,
          unit: input.unit,
          ...(input.minStock === undefined ? {} : { minStock: input.minStock }),
          ...(input.reorderQty === undefined ? {} : { reorderQty: input.reorderQty }),
          internalSku,
          command: { key: input.commandKey, fingerprint },
        });

        await writeAudit(tx, {
          action: AUDIT_ACTIONS.SKU_ONBOARD,
          module: AUDIT_MODULES.PRODUCTOS,
          entity: "Product",
          entityId: product.id,
          after: {
            internalSku: product.internalSku,
            name: product.name,
            skuStatus: product.skuStatus,
          },
          context: { ...input.context, userId: input.actor.id },
        });

        return product;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Dos índices únicos pueden rechazar este INSERT y piden respuestas
      // opuestas. Cuál fue no se le pregunta al error —esa forma es un detalle
      // interno del adapter—, se le pregunta a la base: si ya hay una fila con
      // esta clave de comando, otro proceso ganó la carrera y esto es el mismo
      // reintento del operador llegando por dos caminos.
      const stored = await findProductByIdentityCommandKey(input.commandKey);
      if (stored) return replayOrConflict(stored, fingerprint);

      // No hay fila con esta clave: lo que colisionó fue el SKU. El intento
      // siguiente acuña otro, en su propia transacción.
    }
  }
}

// --------------------------------------------------------------------------
// Vínculo con el código Orion.
//
// La versión de identidad que llega es la que MOSTRÓ la pantalla, y viaja
// directo al compare-and-set. No se relee fresco a propósito: releer sería
// pisar en silencio lo que otro operador acaba de vincular. Si la versión
// quedó vieja, el operador se entera y recarga.
//
// El vínculo y su auditoría entran en la MISMA transacción, igual que el alta.
// --------------------------------------------------------------------------

export type LinkOrionCodeInput = {
  actor: SkuOnboardingActor;
  /** Identidad EXACTA del producto destino: id, SKU interno o código Orion. */
  identity: IdentityInput;
  orionCode: string;
  /**
   * `RELINK` y `FIX` son decisiones explícitas: cambiar identidad nunca es
   * colateral. RELINK mueve un código a OTRO producto; FIX reemplaza el código
   * equivocado de ESTE.
   */
  intent: "LINK" | "RELINK" | "FIX";
  /** Versión de identidad que la pantalla le mostró al operador. */
  expectedVersion: number;
  /** Ídem del producto que hoy tiene el código, cuando se lo muda. */
  holderExpectedVersion?: number;
  context?: AuditContext;
};

export type LinkOrionCodeDeps = {
  writeAudit?: TransactionalAuditWriter;
};

export async function linkOrionCode(
  input: LinkOrionCodeInput,
  deps: LinkOrionCodeDeps = {},
): Promise<Product> {
  // Corregir y acuñar no son la misma autoridad. Acuñar CREA identidad, así
  // que queda en quien da de alta catálogo; corregir REPARA una que ya está
  // mal, y ahí entra supervisión, que es quien recibe el reclamo del vendedor.
  if (input.intent === "FIX") {
    assertCanFixSkuIdentity(input.actor.role);
  } else {
    assertCanOnboardSku(input.actor.role);
  }

  const orionCode = normalizeOrionCode(input.orionCode);
  const product = await findProductByIdentity(input.identity);
  assertIdentityMatches(input.identity, product);

  const holder = await findProductByIdentity({ orionCode });
  const plan = planOrionLink({
    product: product as SkuIdentityRecord,
    orionCode,
    holder,
    intent: input.intent,
  });

  const writeAudit = deps.writeAudit ?? recordAuditInTransaction;

  return prisma.$transaction(async (tx) => {
    const linked = await applyOrionLink(
      plan,
      {
        expectedVersion: input.expectedVersion,
        ...(input.holderExpectedVersion === undefined
          ? {}
          : { holderExpectedVersion: input.holderExpectedVersion }),
      },
      tx,
    );

    // Repetir un vínculo que ya existe no es un evento: no escribió nada, y
    // auditarlo llenaría la historia de ruido.
    if (plan.action === "NOOP") return linked;

    if (plan.action === "RELINK") {
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.SKU_ORION_RELEASE,
        module: AUDIT_MODULES.PRODUCTOS,
        entity: "Product",
        entityId: plan.releasedFromProductId,
        before: { orionCode },
        after: { orionCode: null, movedToProductId: plan.productId },
        context: { ...input.context, userId: input.actor.id },
      });
    }

    const AUDIT_BY_ACTION = {
      FIX: AUDIT_ACTIONS.SKU_ORION_FIX,
      RELINK: AUDIT_ACTIONS.SKU_ORION_RELINK,
      LINK: AUDIT_ACTIONS.SKU_ORION_LINK,
    } as const;

    await writeAudit(tx, {
      action: AUDIT_BY_ACTION[plan.action],
      module: AUDIT_MODULES.PRODUCTOS,
      entity: "Product",
      entityId: linked.id,
      // En una corrección el "antes" NO es nulo, y ese dato es justamente lo
      // que hace reconstruible el error: sin el código viejo, reconciliar
      // hacia atrás contra Orion es imposible.
      before: {
        orionCode: plan.action === "FIX" ? plan.previousOrionCode : null,
        identityVersion: input.expectedVersion,
      },
      after: {
        orionCode: linked.orionCode,
        identityVersion: linked.identityVersion,
        ...(plan.action === "RELINK"
          ? { releasedFromProductId: plan.releasedFromProductId }
          : {}),
      },
      context: { ...input.context, userId: input.actor.id },
    });

    return linked;
  });
}
