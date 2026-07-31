/**
 * Verificación de invariantes de cumplimiento contra una base PostgreSQL REAL.
 *
 * Los tests unitarios usan mocks: no pueden probar bloqueos de fila, ni
 * transacciones, ni restricciones. Este script sí, porque corre contra una base
 * de verdad. Prueba el escenario exacto que reportó gerencia:
 *
 *   Stock disponible: 5
 *   Pedido cliente A: 4
 *   Pedido cliente B: 4
 *   Demanda abierta total: 8  ->  faltante REAL a comprar: 3, no 8
 *
 * El error que evita es calcular cada pendiente contra el MISMO stock: promete
 * las mismas 5 unidades a dos clientes y le pide de más al proveedor.
 *
 * Además comprueba que cancelar libera la reserva (sin necesidad de compra
 * fantasma), que un vendedor no puede operar un pendiente ajeno, y que dos
 * registros simultáneos no reparten dos veces la misma unidad.
 *
 * ATENCIÓN — ES DESTRUCTIVO. Borra pendientes, lotes y faltantes para armar un
 * escenario limpio. Solo corre contra una base descartable y solo con el flag
 * explícito, para que nadie lo apunte a producción por accidente:
 *
 *   DATABASE_URL=postgresql://... AUTH_SECRET=... ALLOW_DESTRUCTIVE_VERIFY=1 \
 *     pnpm --filter @drogueria/web db:verify
 */
import { prisma } from "@/lib/db/prisma";

if (process.env.ALLOW_DESTRUCTIVE_VERIFY !== "1") {
  console.error(
    "Este script BORRA datos operativos. Ejecutalo solo contra una base descartable,\n" +
      "con ALLOW_DESTRUCTIVE_VERIFY=1 en el entorno.",
  );
  process.exit(1);
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FALLA: ${message}`);
  console.log(`  ok  ${message}`);
}

async function main() {
  const { registerPending, cancelPendingCommitment } = await import(
    "@/server/services/pending.service"
  );

  // Escenario limpio
  await prisma.pendingInventoryReservation.deleteMany();
  await prisma.inventoryAllocation.deleteMany();
  await prisma.missingItem.deleteMany();
  await prisma.pendingDelivery.deleteMany();
  await prisma.pending.deleteMany();
  await prisma.productBatch.deleteMany();

  const seller = await prisma.user.upsert({
    where: { email: "vendedor@test.local" },
    update: {},
    create: {
      email: "vendedor@test.local",
      passwordHash: "x",
      name: "Vendedora",
      role: "OPERADOR",
      active: true,
    },
  });
  const product = await prisma.product.upsert({
    where: { code: "AGG-1" },
    update: {},
    create: { code: "AGG-1", name: "Producto agregado", unit: "unidad", active: true },
  });

  const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  await prisma.productBatch.create({
    data: {
      productId: product.id,
      batchCode: "L-1",
      quantity: 5,
      expiresAt: future,
      status: "DISPONIBLE",
    },
  });

  const base = {
    productId: product.id,
    promisedAt: new Date(Date.now() + 86_400_000),
    customerPhone: "3000000000",
    createdById: seller.id,
  };

  console.log("\nEscenario: stock 5, pedido A = 4, pedido B = 4");
  const a = await registerPending({ ...base, quantity: 4, customerName: "Cliente A" });
  const b = await registerPending({ ...base, quantity: 4, customerName: "Cliente B" });

  const pendingA = await prisma.pending.findUniqueOrThrow({ where: { id: a.pending.id } });
  const pendingB = await prisma.pending.findUniqueOrThrow({ where: { id: b.pending.id } });

  assert(pendingA.inventoryReadyQuantity === 4, "A toma 4 de las 5 unidades");
  assert(pendingB.inventoryReadyQuantity === 1, "B toma solo la unidad que quedaba, no las 5 otra vez");

  const totalMissing = await prisma.missingItem.aggregate({
    where: { productId: product.id, status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
    _sum: { quantity: true },
  });
  assert(
    (totalMissing._sum.quantity ?? 0) === 3,
    `el faltante a comprar es 3 (obtenido: ${totalMissing._sum.quantity ?? 0})`,
  );

  const remaining = await prisma.productBatch.aggregate({
    where: { productId: product.id },
    _sum: { quantity: true },
  });
  assert((remaining._sum.quantity ?? 0) === 0, "el lote queda en 0: nada se promete dos veces");

  const reservations = await prisma.pendingInventoryReservation.aggregate({
    _sum: { quantity: true },
  });
  assert((reservations._sum.quantity ?? 0) === 5, "las 5 unidades quedan reservadas y trazadas");

  console.log("\nEscenario: se cancela el pedido B");
  const cancelled = await cancelPendingCommitment({
    id: b.pending.id,
    cancelledById: seller.id,
    reason: "prueba",
    canManageAll: false,
  });
  assert(cancelled.rejection === null, "el vendedor dueño puede cancelar su pendiente");

  const afterCancel = await prisma.productBatch.aggregate({
    where: { productId: product.id },
    _sum: { quantity: true },
  });
  assert(
    (afterCancel._sum.quantity ?? 0) === 1,
    `la unidad reservada por B vuelve al lote (obtenido: ${afterCancel._sum.quantity ?? 0})`,
  );

  const ghost = await prisma.missingItem.aggregate({
    where: { originId: b.pending.id, status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
    _sum: { quantity: true },
  });
  assert((ghost._sum.quantity ?? 0) === 0, "no queda necesidad de compra fantasma de B");

  console.log("\nEscenario: un vendedor ajeno intenta cancelar el pedido A");
  const intruder = await prisma.user.upsert({
    where: { email: "otro@test.local" },
    update: {},
    create: {
      email: "otro@test.local",
      passwordHash: "x",
      name: "Otro",
      role: "OPERADOR",
      active: true,
    },
  });
  const denied = await cancelPendingCommitment({
    id: a.pending.id,
    cancelledById: intruder.id,
    canManageAll: false,
  });
  assert(denied.rejection === "NOT_OWNER", "el sistema rechaza operar un pendiente ajeno");

  console.log("\nEscenario: dos vendedores registran A LA VEZ contra el mismo lote");
  await prisma.pendingInventoryReservation.deleteMany();
  await prisma.missingItem.deleteMany();
  await prisma.pending.deleteMany();
  await prisma.productBatch.deleteMany();
  await prisma.productBatch.create({
    data: {
      productId: product.id,
      batchCode: "L-CONC",
      quantity: 5,
      expiresAt: future,
      status: "DISPONIBLE",
    },
  });

  const [c1, c2] = await Promise.all([
    registerPending({ ...base, quantity: 4, customerName: "Concurrente 1" }),
    registerPending({ ...base, quantity: 4, customerName: "Concurrente 2" }),
  ]);
  const p1 = await prisma.pending.findUniqueOrThrow({ where: { id: c1.pending.id } });
  const p2 = await prisma.pending.findUniqueOrThrow({ where: { id: c2.pending.id } });

  assert(
    p1.inventoryReadyQuantity + p2.inventoryReadyQuantity === 5,
    `entre los dos toman exactamente las 5 unidades (${p1.inventoryReadyQuantity} + ${p2.inventoryReadyQuantity})`,
  );
  const leftover = await prisma.productBatch.aggregate({
    where: { productId: product.id },
    _sum: { quantity: true },
  });
  assert((leftover._sum.quantity ?? 0) === 0, "el lote no queda en negativo ni sobra stock inventado");
  const concurrentMissing = await prisma.missingItem.aggregate({
    where: { productId: product.id, status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
    _sum: { quantity: true },
  });
  assert(
    (concurrentMissing._sum.quantity ?? 0) === 3,
    `el faltante sigue siendo 3 bajo concurrencia (obtenido: ${concurrentMissing._sum.quantity ?? 0})`,
  );

  console.log("\nTODO VERIFICADO CONTRA POSTGRESQL REAL\n");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
