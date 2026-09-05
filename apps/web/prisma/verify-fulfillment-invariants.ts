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
  // Nace CON código de Orion, y el `update` también lo fija: desde H3 no entra
  // mercadería al inventario sin SKU, así que un producto de prueba sin él no
  // puede recorrer el flujo completo. El `update` importa porque este guion se
  // corre muchas veces contra la misma base descartable y la fila puede venir
  // de una corrida anterior a este campo.
  const product = await prisma.product.upsert({
    where: { code: "AGG-1" },
    update: { orionCode: "AGG0001" },
    create: {
      code: "AGG-1",
      name: "Producto agregado",
      unit: "unidad",
      active: true,
      orionCode: "AGG0001",
    },
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
  const a = await registerPending({ ...base, quantity: 4, customerName: "Cliente A", idempotencyKey: crypto.randomUUID() });
  const b = await registerPending({ ...base, quantity: 4, customerName: "Cliente B", idempotencyKey: crypto.randomUUID() });

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
  assert(
    (remaining._sum.quantity ?? 0) === 5,
    `el lote físico NO se toca al registrar pedidos (obtenido: ${remaining._sum.quantity ?? 0})`,
  );

  // El compromiso vive en el pendiente, no en el lote: es lo que permite saber
  // cuánto del stock ya tiene dueño sin alterar el conteo de la estantería.
  const committed = await prisma.pending.aggregate({
    where: { productId: product.id, status: { notIn: ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] } },
    _sum: { inventoryReadyQuantity: true },
  });
  assert(
    (committed._sum.inventoryReadyQuantity ?? 0) === 5,
    `las 5 unidades quedan comprometidas y trazadas (obtenido: ${committed._sum.inventoryReadyQuantity ?? 0})`,
  );

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
    (afterCancel._sum.quantity ?? 0) === 5,
    `cancelar tampoco inventa stock en el lote (obtenido: ${afterCancel._sum.quantity ?? 0})`,
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
    registerPending({ ...base, quantity: 4, customerName: "Concurrente 1", idempotencyKey: crypto.randomUUID() }),
    registerPending({ ...base, quantity: 4, customerName: "Concurrente 2", idempotencyKey: crypto.randomUUID() }),
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
  assert((leftover._sum.quantity ?? 0) === 5, "el lote sigue intacto bajo concurrencia");
  const concurrentMissing = await prisma.missingItem.aggregate({
    where: { productId: product.id, status: { in: ["FALTANTE", "PEDIDO", "EN_BODEGA"] } },
    _sum: { quantity: true },
  });
  assert(
    (concurrentMissing._sum.quantity ?? 0) === 3,
    `el faltante sigue siendo 3 bajo concurrencia (obtenido: ${concurrentMissing._sum.quantity ?? 0})`,
  );

  console.log("\nEscenario: facturar antes de que la mercancía esté cargada");
  await prisma.pendingInventoryReservation.deleteMany();
  await prisma.missingItem.deleteMany();
  await prisma.pendingDelivery.deleteMany();
  await prisma.pending.deleteMany();
  await prisma.productBatch.deleteMany();

  const { invoicePending, deliverPending, resolveWaitlistDecision } = await import(
    "@/server/services/pending.service"
  );

  const sinStock = await registerPending({ ...base, quantity: 5, customerName: "Cliente F", idempotencyKey: crypto.randomUUID() });
  const registrado = await prisma.pending.findUniqueOrThrow({ where: { id: sinStock.pending.id } });
  assert(registrado.inventoryReadyQuantity === 0, "el pendiente nace sin nada disponible");

  // REGLA VIGENTE (reunión 2026-10-04): sin mercadería cargada NO se factura.
  //
  // Este escenario afirmaba lo contrario hasta hoy. La migración
  // `20260731010000_invoice_before_arrival` había sacado el CHECK
  // `invoicedQuantity <= inventoryReadyQuantity` para que el vendedor pudiera
  // facturar mirando su propia caja, y este guion lo dejaba fijado. El negocio
  // revirtió esa decisión: gerencia veía el botón "Facturar" sobre pendientes
  // sin una sola unidad en bodega, y facturar lo que no llegó descuadra la
  // entrega. La comprobación vive ahora en `invoicePending`.
  assert(
    (await invoicePending({
      id: sinStock.pending.id,
      actorId: seller.id,
      scope: "own",
      quantity: 5,
    })) === "NO_STOCK",
    "sin mercadería cargada no se puede facturar",
  );

  // El alcance es parte del contrato: un vendedor sobre un pendiente ajeno se
  // rechaza por propiedad, no por stock.
  assert(
    (await invoicePending({
      id: sinStock.pending.id,
      actorId: "otro-vendedor",
      scope: "own",
    })) === "NOT_OWNER",
    "el vendedor no factura el pendiente de otro",
  );

  // Y un rol sin autoridad se rechaza antes de mirar la fila.
  assert(
    (await invoicePending({
      id: sinStock.pending.id,
      actorId: seller.id,
      scope: "none",
    })) === "NOT_AUTHORIZED",
    "un rol sin autoridad de facturación no factura ni el pendiente propio",
  );

  console.log("\nEscenario: llega solo una parte y el cliente decide");

  // ACÁ FALTABA LA LLEGADA. El escenario decía "llega solo una parte" y no
  // hacía llegar nada: entregaba contra un pendiente con reserva CERO. Pasó
  // mientras el techo de la entrega eran solo los compromisos comerciales —lo
  // pedido y lo facturado—; cuando se agregó el tercer techo (`reservedQuantity`,
  // que es lo que impide registrar la salida de mercadería que nunca entró)
  // este script quedó fallando y dejó de correrse.
  //
  // Se hace llegar por el CAMINO REAL, `registerInventoryEntry`, no escribiendo
  // el lote a mano: así el guion prueba la cadena entera —asignación FIFO,
  // reserva contra el pendiente y aviso al vendedor— en vez de una maqueta.
  const { registerInventoryEntry } = await import(
    "@/server/services/inventory-entry.service"
  );
  await registerInventoryEntry({
    productId: product.id,
    quantity: 3,
    batchCode: `LOTE-PARCIAL-${Date.now()}`,
    expiresAt: new Date(Date.now() + 31_536_000_000),
    createdById: seller.id,
    idempotencyKey: crypto.randomUUID(),
  });

  const conLlegada = await prisma.pending.findUniqueOrThrow({
    where: { id: sinStock.pending.id },
  });
  assert(
    conLlegada.inventoryReadyQuantity === 3,
    `la entrada reserva las 3 unidades al pendiente (obtenido: ${conLlegada.inventoryReadyQuantity})`,
  );
  assert(
    conLlegada.availabilityStatus === "DISPONIBLE_PARCIAL",
    `queda disponible parcial, no completo (obtenido: ${conLlegada.availabilityStatus})`,
  );

  assert(
    (await deliverPending({
      id: sinStock.pending.id,
      quantity: 3,
      deliveredById: seller.id,
      canManageAll: false,
    })).rejection === null,
    "se entregan las 3 unidades que llegaron",
  );
  const parcial = await prisma.pending.findUniqueOrThrow({ where: { id: sinStock.pending.id } });
  assert(parcial.status === "PARCIAL", "el pendiente queda en entrega parcial");

  assert(
    (await resolveWaitlistDecision({
      id: sinStock.pending.id,
      decision: "espera",
      actorId: seller.id,
    })) === null,
    "si el cliente espera, el pendiente sigue abierto",
  );
  const esperando = await prisma.pending.findUniqueOrThrow({ where: { id: sinStock.pending.id } });
  assert(esperando.status === "PARCIAL", "sigue abierto tras registrar que espera");
  assert(
    (esperando.note ?? "").includes("Cliente espera los 2"),
    `queda la nota del vendedor (obtenido: ${esperando.note ?? "sin nota"})`,
  );

  assert(
    (await resolveWaitlistDecision({
      id: sinStock.pending.id,
      decision: "cerrar",
      actorId: seller.id,
    })) === null,
    "si no los espera, se cierra con lo entregado",
  );
  // T2.2b: el cierre parcial tiene estado propio; la ecuación cierra con lo
  // que el cliente ya no espera (5 pedidos, 3 entregados, 2 cancelados).
  const cerrado = await prisma.pending.findUniqueOrThrow({ where: { id: sinStock.pending.id } });
  assert(cerrado.status === "CLOSED_PARTIAL", "cierra parcial, no cancelado: hubo entrega");
  assert(cerrado.deliveredQuantity === 3, "se cierra con las 3 que realmente recibió");
  assert(cerrado.cancelledQuantity === 2, "registra los 2 que el cliente no espera");

  console.log("\nEscenario: corregir un pendiente");
  const { updatePending } = await import("@/server/services/pending.service");
  const paraEditar = await registerPending({ ...base, quantity: 4, customerName: "Cliente E", idempotencyKey: crypto.randomUUID() });

  const correccion = {
    id: paraEditar.pending.id,
    productId: product.id,
    quantity: 6,
    promisedAt: new Date(Date.now() + 172_800_000),
    customerName: "Cliente E corregido",
    customerPhone: "3009999999",
  };

  assert(
    (await updatePending({ ...correccion, actorId: intruder.id, canManageAll: false })).rejection ===
      "NOT_OWNER",
    "un vendedor ajeno no corrige un pendiente que no es suyo",
  );

  assert(
    (await updatePending({ ...correccion, actorId: seller.id, canManageAll: false })).rejection ===
      null,
    "el vendedor dueño corrige su pendiente",
  );
  const corregido = await prisma.pending.findUniqueOrThrow({ where: { id: paraEditar.pending.id } });
  assert(corregido.quantity === 6, "la cantidad quedó corregida");
  assert(corregido.customerName === "Cliente E corregido", "el cliente quedó corregido");
  assert(corregido.sellerEditedAt !== null, "queda registrado cuándo corrigió");

  assert(
    (await updatePending({ ...correccion, quantity: 7, actorId: seller.id, canManageAll: false }))
      .rejection === "ALREADY_EDITED",
    "el vendedor NO puede corregir una segunda vez",
  );

  assert(
    (await updatePending({ ...correccion, quantity: 8, actorId: intruder.id, canManageAll: true }))
      .rejection === null,
    "gerencia corrige cualquier pendiente, sin límite",
  );
  const porGerencia = await prisma.pending.findUniqueOrThrow({
    where: { id: paraEditar.pending.id },
  });
  assert(porGerencia.quantity === 8, "la corrección de gerencia se aplicó");
  assert(
    porGerencia.sellerEditedAt?.getTime() === corregido.sellerEditedAt?.getTime(),
    "gerencia NO consume el cupo del vendedor",
  );

  assert(
    (await updatePending({ ...correccion, quantity: 8, actorId: intruder.id, canManageAll: true }))
      .rejection === null,
    "gerencia puede corregir de nuevo",
  );

  console.log("\nTODO VERIFICADO CONTRA POSTGRESQL REAL\n");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
