// --------------------------------------------------------------------------
// Datos de DEMO para mostrar el circuito completo a los encargados: un vendedor
// (Juan), catálogo con laboratorios y stock, pendientes con estado de gestión,
// faltantes en distintos estados y un reporte esperando revisión. Toca las 5
// mejoras del sprint.
//
// IDEMPOTENTE: upsert por clave natural (email/código/nombre) y por ids "demo-"
// en las filas transaccionales, así re-ejecutarlo no duplica. Pensado para
// correr sobre una base recién blanqueada o recién seedeada.
//
// Guarda explícita: corre solo con  CONFIRM_DEMO=si  (agrega datos ficticios;
// no querés meterlos sin querer en una base con operación real).
// --------------------------------------------------------------------------

import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../lib/auth/password";
import { normalizeMissingReportName } from "../features/faltantes/missing-report-name";
import { PrismaClient } from "../lib/generated/prisma/client";

const CONFIRM = process.env.CONFIRM_DEMO;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "123456789";
const DEMO_SELLER_EMAIL = "vendedor@drogueriaespecifica.com";
const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  if (CONFIRM !== "si") {
    console.error(
      "Demo ABORTADA: falta la confirmación explícita.\n" +
        "Volvé a correrla con  CONFIRM_DEMO=si  para cargar los datos de ejemplo.",
    );
    process.exitCode = 1;
    return;
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? "",
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const passwordHash = await hashPassword(DEMO_PASSWORD);

    // Gerencia = el SUPERADMIN existente (lo crea el seed). Se usa como quien
    // pide/gestiona. Si todavía no existe, se omiten las referencias a él.
    const admin = await prisma.user.findFirst({ where: { role: "SUPERADMIN" } });

    // --- Vendedor (el que reporta y registra pendientes) ---
    // upsert: si el email ya existe, lo reutiliza (asegura rol/estado/clave demo);
    // si no, lo crea.
    const vendedor = await prisma.user.upsert({
      where: { email: DEMO_SELLER_EMAIL },
      update: { name: "Juan Esteban", role: "OPERADOR", active: true, passwordHash },
      create: {
        email: DEMO_SELLER_EMAIL,
        name: "Juan Esteban",
        role: "OPERADOR",
        active: true,
        passwordHash,
      },
    });

    // --- Laboratorios ---
    const genfar = await prisma.laboratory.upsert({
      where: { name: "Genfar" },
      update: {},
      create: { name: "Genfar" },
    });
    const bayer = await prisma.laboratory.upsert({
      where: { name: "Bayer" },
      update: {},
      create: { name: "Bayer" },
    });

    // --- Productos (con laboratorio, para la vista compacta y el export) ---
    const acetaminofen = await prisma.product.upsert({
      where: { code: "MED-001" },
      update: { laboratoryId: genfar.id },
      create: { code: "MED-001", name: "Acetaminofén 500mg", unit: "caja", minStock: 20, reorderQty: 50, laboratoryId: genfar.id },
    });
    const ibuprofeno = await prisma.product.upsert({
      where: { code: "MED-002" },
      update: { laboratoryId: bayer.id },
      create: { code: "MED-002", name: "Ibuprofeno 400mg", unit: "caja", minStock: 15, reorderQty: 40, laboratoryId: bayer.id },
    });
    const loratadina = await prisma.product.upsert({
      where: { code: "MED-003" },
      update: { laboratoryId: genfar.id },
      create: { code: "MED-003", name: "Loratadina 10mg", unit: "caja", minStock: 10, reorderQty: 30, laboratoryId: genfar.id },
    });

    // --- Proveedor ---
    const proveedor = await prisma.supplier.upsert({
      where: { name: "Distribuidora Norte" },
      update: {},
      create: { name: "Distribuidora Norte" },
    });

    // --- Stock: solo Acetaminofén tiene lote disponible (los otros dan faltante) ---
    await prisma.productBatch.upsert({
      where: { productId_batchCode: { productId: acetaminofen.id, batchCode: "LOTE-DEMO-1" } },
      update: { quantity: 50, status: "DISPONIBLE" },
      create: {
        productId: acetaminofen.id,
        batchCode: "LOTE-DEMO-1",
        quantity: 50,
        status: "DISPONIBLE",
        expiresAt: new Date(Date.now() + 365 * DAY_MS),
      },
    });

    const tomorrow = new Date(Date.now() + DAY_MS);

    // --- Pendientes (los registra el vendedor) ---
    // 1) Con stock: se puede entregar.
    await prisma.pending.upsert({
      where: { id: "demo-pending-1" },
      update: {},
      create: {
        id: "demo-pending-1",
        productId: acetaminofen.id,
        quantity: 5,
        promisedAt: tomorrow,
        customerName: "Cliente Demo",
        note: "Solicitud de mostrador",
        status: "PENDIENTE",
        createdById: vendedor.id,
      },
    });
    // 2) Sin stock + estado de gestión SOLICITADO (Mejora 2).
    await prisma.pending.upsert({
      where: { id: "demo-pending-2" },
      update: {},
      create: {
        id: "demo-pending-2",
        productId: ibuprofeno.id,
        quantity: 10,
        promisedAt: tomorrow,
        customerName: "Cliente Demo 2",
        status: "SOLICITADO",
        createdById: vendedor.id,
      },
    });

    // --- Faltantes ---
    // 1) FALTANTE abierto (como el que genera un pendiente sin stock), pedido por Juan.
    await prisma.missingItem.upsert({
      where: { id: "demo-missing-1" },
      update: {},
      create: {
        id: "demo-missing-1",
        productId: ibuprofeno.id,
        quantity: 10,
        status: "FALTANTE",
        createdById: vendedor.id,
      },
    });
    // 2) PEDIDO a un proveedor (muestra estado + proveedor en el export).
    await prisma.missingItem.upsert({
      where: { id: "demo-missing-2" },
      update: {},
      create: {
        id: "demo-missing-2",
        productId: loratadina.id,
        quantity: 8,
        status: "PEDIDO",
        supplierId: proveedor.id,
        orderedAt: new Date(),
        orderedQuantity: 8,
        createdById: vendedor.id,
        ...(admin ? { orderedById: admin.id } : {}),
      },
    });

    // --- Reporte del vendedor esperando revisión (cola /revision-faltantes) ---
    const rawName = "Loratadina 10mg";
    await prisma.missingReport.upsert({
      where: { id: "demo-report-1" },
      update: {},
      create: {
        id: "demo-report-1",
        rawName,
        normalizedName: normalizeMissingReportName(rawName),
        reporterId: vendedor.id,
        status: "PENDING_REVIEW",
      },
    });

    console.log(
      `Demo OK. Vendedor: ${DEMO_SELLER_EMAIL} (OPERADOR) | pass: ` +
        `${DEMO_PASSWORD} | 3 productos, 1 proveedor, 2 pendientes, 2 faltantes, 1 reporte.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Demo falló:", error);
  process.exitCode = 1;
});
