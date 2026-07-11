import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/generated/prisma/client";

export type UpsertSupplierByNameData = {
  name: string;
  phone?: string | null;
  address?: string | null;
  email?: string | null;
};

export type ProductSupplierLinkData = {
  productId: string;
  supplierId: string;
};

// `client` permite ejecutar la lectura dentro de una transacción (ver
// `orderMissingItem` en el service): así la relectura ve lo que escribió una
// operación concurrente que ya confirmó en su propia tx.
export function findSupplierById(
  id: string,
  client: Prisma.TransactionClient = prisma,
): Promise<{ id: string } | null> {
  return client.supplier.findUnique({ where: { id }, select: { id: true } });
}

// Alta o reutilización de un proveedor por su nombre único. Corre SIEMPRE
// dentro de una transacción (`tx` obligatorio). El nombre único ES la
// identidad del proveedor, así que hacer upsert por `name` reutiliza el
// existente en vez de romper por la restricción unique: es una reutilización
// intencional, no una fusión silenciosa de datos.
export function upsertSupplierByName(
  tx: Prisma.TransactionClient,
  data: UpsertSupplierByNameData,
): Promise<{ id: string }> {
  return tx.supplier.upsert({
    where: { name: data.name },
    create: {
      name: data.name,
      phone: data.phone ?? null,
      address: data.address ?? null,
      email: data.email ?? null,
    },
    update: {},
    select: { id: true },
  });
}

// Enlace producto↔proveedor, idempotente por la unique compuesta
// `@@unique([productId, supplierId])`. Corre SIEMPRE dentro de la transacción
// del pedido. No toca `isRecurrent`: ese flag se mantiene en su default
// (`false`) y se gestiona manualmente en otro lado.
export async function upsertProductSupplierLink(
  tx: Prisma.TransactionClient,
  data: ProductSupplierLinkData,
): Promise<void> {
  await tx.productSupplier.upsert({
    where: {
      productId_supplierId: {
        productId: data.productId,
        supplierId: data.supplierId,
      },
    },
    create: { productId: data.productId, supplierId: data.supplierId },
    update: {},
  });
}
