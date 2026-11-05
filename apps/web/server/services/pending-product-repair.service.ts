import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  recordAuditInTransaction,
  type TransactionalAuditWriter,
} from "@/server/services/transactional-audit.service";

export type PendingProductRepairManifest = {
  repairId: string;
  actorEmail: string;
  pendingId: string;
  expectedCurrentProductId: string;
  expectedCurrentProductName: string;
  expectedCurrentProductOrionCode: string | null;
  targetProductId: string;
  expectedQuantity: number;
  expectedStatus: string;
  expectedPurchaseStatus: string;
  expectedAvailabilityStatus: string;
  expectedCustomerStatus: string;
  expectedTargetName: string;
  expectedTargetOrionCode: string;
  reason: string;
  apply?: boolean;
};

export type ApprovedPendingProductRepair = Omit<PendingProductRepairManifest, "apply">;

export const APPROVED_PENDING_PRODUCT_REPAIR: ApprovedPendingProductRepair = {
  repairId: "incident-330-laura-pending-product",
  actorEmail: "admin@ilasesorias.com",
  pendingId: "cmw15djdt00ph01qsk9oqssrp",
  expectedCurrentProductId: "cmw15hzoy00pt01qs7m2g73b8",
  expectedCurrentProductName: "ATODER CREMA ULTRA HYDRATANTE X 500 ML ref",
  expectedCurrentProductOrionCode: null,
  targetProductId: "cmtvwdmrw00ce01nxpuzhebl8",
  expectedQuantity: 2,
  expectedStatus: "PENDIENTE",
  expectedPurchaseStatus: "SOLICITADO",
  expectedAvailabilityStatus: "ESPERANDO",
  expectedCustomerStatus: "POR_CONTACTAR",
  expectedTargetName: "CITIVITAE 1000 MG X 10 SOBRES",
  expectedTargetOrionCode: "A33731",
  reason: "Restore the product confirmed by the original request fingerprint and incident #330.",
};

export type PendingProductRepairReport = {
  status: "planned" | "applied" | "noop" | "blocked";
  applied: boolean;
  pendingId: string;
  fromProductId: string;
  toProductId: string;
  quantity: number;
  blockers: string[];
};

type LockedProduct = { id: string; name: string; orionCode: string | null; active: boolean };
type LockedActor = {
  id: string;
  email: string;
  role: string;
  active: boolean;
  archivedAt: Date | null;
};

class RepairConcurrencyError extends Error {}

export async function repairPendingProduct(
  manifest: PendingProductRepairManifest,
  deps: {
    writeAudit?: TransactionalAuditWriter;
    approvedRepair?: ApprovedPendingProductRepair;
  } = {},
): Promise<PendingProductRepairReport> {
  const apply = manifest.apply === true;
  const writeAudit = deps.writeAudit ?? recordAuditInTransaction;
  const approved = deps.approvedRepair ?? APPROVED_PENDING_PRODUCT_REPAIR;

  try {
    return await prisma.$transaction(async (tx) => {
      const blockers = approvedScopeBlockers(manifest, approved);

      const actors = await tx.$queryRaw<LockedActor[]>(Prisma.sql`
        SELECT id, email, role, active, "archivedAt"
        FROM users
        WHERE email = ${manifest.actorEmail}
        FOR UPDATE
      `);
      const actor = actors[0];
      if (!actor || !actor.active || actor.archivedAt || !["ADMIN", "SUPERADMIN"].includes(actor.role)) {
        blockers.push(
          `El actor ${manifest.actorEmail} no existe, está inactivo o no tiene rol administrativo.`,
        );
      }

      const productIds = [manifest.expectedCurrentProductId, manifest.targetProductId].sort((a, b) =>
        a.localeCompare(b),
      );
      const products = await tx.$queryRaw<LockedProduct[]>(Prisma.sql`
        SELECT id, name, "orionCode", active
        FROM products
        WHERE id IN (${Prisma.join(productIds)})
        ORDER BY id
        FOR UPDATE
      `);
      const currentProduct = products.find((product) => product.id === manifest.expectedCurrentProductId);
      const targetProduct = products.find((product) => product.id === manifest.targetProductId);
      validateProduct(
        blockers,
        currentProduct,
        "actual",
        manifest.expectedCurrentProductName,
        manifest.expectedCurrentProductOrionCode,
      );
      validateProduct(
        blockers,
        targetProduct,
        "objetivo",
        manifest.expectedTargetName,
        manifest.expectedTargetOrionCode,
      );

      await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM pendings WHERE id = ${manifest.pendingId} FOR UPDATE
      `);
      const pending = await tx.pending.findUnique({ where: { id: manifest.pendingId } });
      if (!pending) return blocked(manifest, [`El pendiente ${manifest.pendingId} no existe.`]);

      const alreadyRepaired = pending.productId === manifest.targetProductId;
      if (!alreadyRepaired && pending.productId !== manifest.expectedCurrentProductId) {
        blockers.push(
          `El producto del pendiente cambió: se esperaba ${manifest.expectedCurrentProductId} y existe ${pending.productId}.`,
        );
      }
      if (pending.quantity !== manifest.expectedQuantity) {
        blockers.push(`La cantidad cambió: se esperaba ${manifest.expectedQuantity} y existe ${pending.quantity}.`);
      }
      if (pending.status !== manifest.expectedStatus) blockers.push(`El estado cambió a ${pending.status}.`);
      if (pending.purchaseStatus !== manifest.expectedPurchaseStatus) {
        blockers.push(`El estado de compra cambió a ${pending.purchaseStatus}.`);
      }
      if (pending.availabilityStatus !== manifest.expectedAvailabilityStatus) {
        blockers.push(`El estado de disponibilidad cambió a ${pending.availabilityStatus}.`);
      }
      if (pending.customerStatus !== manifest.expectedCustomerStatus) {
        blockers.push(`El estado del cliente cambió a ${pending.customerStatus}.`);
      }

      const [reservations, allocations, missingItems, deliveries] = await Promise.all([
        tx.pendingInventoryReservation.count({ where: { pendingId: pending.id } }),
        tx.inventoryAllocation.count({ where: { pendingId: pending.id } }),
        tx.missingItem.count({ where: { originId: pending.id } }),
        tx.pendingDelivery.count({ where: { pendingId: pending.id } }),
      ]);
      const hasLifecycleOrSupplyState =
        pending.inventoryReadyQuantity !== 0 ||
        pending.reservedInventoryQuantity !== 0 ||
        pending.invoicedQuantity !== 0 ||
        pending.deliveredQuantity !== 0 ||
        pending.cancelledQuantity !== 0 ||
        reservations !== 0 || allocations !== 0 || missingItems !== 0 || deliveries !== 0 ||
        pending.contactedAt !== null || pending.contactedById !== null ||
        pending.invoicedAt !== null || pending.invoicedById !== null ||
        pending.completedAt !== null || pending.cancelledAt !== null || pending.cancelledById !== null;
      if (hasLifecycleOrSupplyState) {
        blockers.push(
          "El pendiente ya tiene estado comercial, de inventario, facturación, entrega, cancelación o faltantes; no es seguro cambiar solo el producto.",
        );
      }

      if (blockers.length > 0) return blocked(manifest, blockers);
      if (alreadyRepaired) return report(manifest, "noop", false);
      if (!apply) return report(manifest, "planned", false);
      if (!actor) return blocked(manifest, ["No se pudo resolver el actor auditado."]);

      const updated = await tx.pending.updateMany({
        where: {
          id: pending.id,
          productId: manifest.expectedCurrentProductId,
          quantity: manifest.expectedQuantity,
          status: manifest.expectedStatus as never,
          purchaseStatus: manifest.expectedPurchaseStatus as never,
          availabilityStatus: manifest.expectedAvailabilityStatus as never,
          customerStatus: manifest.expectedCustomerStatus as never,
          inventoryReadyQuantity: 0,
          reservedInventoryQuantity: 0,
          invoicedQuantity: 0,
          deliveredQuantity: 0,
          cancelledQuantity: 0,
          contactedAt: null,
          contactedById: null,
          invoicedAt: null,
          invoicedById: null,
          completedAt: null,
          cancelledAt: null,
          cancelledById: null,
        },
        data: { productId: manifest.targetProductId },
      });
      if (updated.count !== 1) {
        throw new RepairConcurrencyError(
          "El pendiente cambió durante la reparación; la transacción se revirtió completa.",
        );
      }

      const auditSnapshot = {
        quantity: pending.quantity,
        status: pending.status,
        purchaseStatus: pending.purchaseStatus,
        availabilityStatus: pending.availabilityStatus,
        customerStatus: pending.customerStatus,
        inventoryReadyQuantity: pending.inventoryReadyQuantity,
        reservedInventoryQuantity: pending.reservedInventoryQuantity,
        invoicedQuantity: pending.invoicedQuantity,
        deliveredQuantity: pending.deliveredQuantity,
        cancelledQuantity: pending.cancelledQuantity,
      };
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PENDING_UPDATE,
        module: AUDIT_MODULES.PENDIENTES,
        entity: "Pending",
        entityId: pending.id,
        before: { productId: manifest.expectedCurrentProductId, ...auditSnapshot, repairReason: manifest.reason },
        after: { productId: manifest.targetProductId, ...auditSnapshot, repairReason: manifest.reason },
        context: { userId: actor.id, channel: manifest.repairId },
      });

      return report(manifest, "applied", true);
    });
  } catch (error) {
    if (error instanceof RepairConcurrencyError) return blocked(manifest, [error.message]);
    throw error;
  }
}

function approvedScopeBlockers(
  manifest: PendingProductRepairManifest,
  approved: ApprovedPendingProductRepair,
): string[] {
  const blockers: string[] = [];
  for (const key of Object.keys(approved) as Array<keyof ApprovedPendingProductRepair>) {
    if (manifest[key] !== approved[key]) {
      blockers.push(`El manifiesto no coincide con la reparación aprobada en "${key}".`);
    }
  }
  return blockers;
}

function validateProduct(
  blockers: string[],
  product: LockedProduct | undefined,
  label: string,
  expectedName: string,
  expectedOrionCode: string | null,
): void {
  if (!product) {
    blockers.push(`El producto ${label} no existe.`);
    return;
  }
  if (!product.active) blockers.push(`El producto ${label} está inactivo.`);
  if (product.name !== expectedName) blockers.push(`El nombre del producto ${label} cambió.`);
  if (product.orionCode !== expectedOrionCode) blockers.push(`El código Orion del producto ${label} cambió.`);
}

function report(
  manifest: PendingProductRepairManifest,
  status: PendingProductRepairReport["status"],
  applied: boolean,
): PendingProductRepairReport {
  return {
    status,
    applied,
    pendingId: manifest.pendingId,
    fromProductId: manifest.expectedCurrentProductId,
    toProductId: manifest.targetProductId,
    quantity: manifest.expectedQuantity,
    blockers: [],
  };
}

function blocked(manifest: PendingProductRepairManifest, blockers: string[]): PendingProductRepairReport {
  return { ...report(manifest, "blocked", false), blockers };
}

export function formatPendingProductRepairReport(value: PendingProductRepairReport): string {
  const lines = [
    `Estado: ${value.status}`,
    `Pendiente: ${value.pendingId}`,
    `Producto actual revisado: ${value.fromProductId}`,
    `Producto objetivo: ${value.toProductId}`,
    `Cantidad preservada: ${value.quantity}`,
    `Aplicado: ${value.applied ? "sí" : "no"}`,
  ];
  if (value.status === "noop") lines.push("No había cambios pendientes; no se escribió nada.");
  if (value.blockers.length > 0) lines.push("Bloqueos:", ...value.blockers.map((item) => `- ${item}`));
  return lines.join("\n");
}
