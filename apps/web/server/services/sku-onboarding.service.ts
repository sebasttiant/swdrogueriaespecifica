import { createHash } from "node:crypto";

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import type { SessionRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import type { Product } from "@/lib/generated/prisma/client";
import {
  assertAttemptWithinBudget,
  assertCanOnboardSku,
} from "@/server/domain/catalog/sku-identity";
import {
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
