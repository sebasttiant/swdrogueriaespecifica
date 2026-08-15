import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import type { SessionRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import type { Product } from "@/lib/generated/prisma/client";
import {
  assertAttemptWithinBudget,
  assertCanOnboardSku,
} from "@/server/domain/catalog/sku-identity";
import {
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
// Dos garantías, y las dos se prueban contra PostgreSQL real:
//
//  1. Solo un actor autorizado acuña identidad.
//  2. El producto y su auditoría entran en la MISMA transacción. Si no se puede
//     dejar rastro, no se acuña la identidad. Decisión del dueño acotada a este
//     flujo (ver `transactional-audit.service.ts`).
// --------------------------------------------------------------------------

export type SkuOnboardingActor = {
  id: string;
  role: SessionRole;
};

export type OnboardProvisionalSkuInput = {
  actor: SkuOnboardingActor;
  name: string;
  unit: string;
  minStock?: number;
  reorderQty?: number;
  context?: AuditContext;
};

export type OnboardProvisionalSkuDeps = {
  generation?: SkuGenerationDeps;
  /** Inyectable para poder probar que una auditoría caída revierte el alta. */
  writeAudit?: TransactionalAuditWriter;
};

export async function onboardProvisionalSku(
  input: OnboardProvisionalSkuInput,
  deps: OnboardProvisionalSkuDeps = {},
): Promise<Product> {
  assertCanOnboardSku(input.actor.role);

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
      // SKU tomado: el intento siguiente acuña otro, en su propia transacción.
    }
  }
}
