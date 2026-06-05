// Seed mínimo de Fase 1. NO crea credenciales reales (auth es Fase 2).
// Carga un usuario admin placeholder y un par de productos de ejemplo
// para que el dashboard y las pantallas tengan datos al desarrollar.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL ?? "",
});
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  const admin = await prisma.user.upsert({
    where: { email: "admin@drogueriaespecifica.com" },
    update: {},
    create: {
      email: "admin@drogueriaespecifica.com",
      name: "Administrador",
      role: "ADMIN",
      // passwordHash se setea cuando se implemente auth (Fase 2)
    },
  });

  const productos = [
    { code: "SKU-001", name: "Acetaminofén 500mg", unit: "caja", minStock: 20, reorderQty: 50 },
    { code: "SKU-002", name: "Ibuprofeno 400mg", unit: "caja", minStock: 15, reorderQty: 40 },
    { code: "SKU-003", name: "Suero fisiológico 500ml", unit: "unidad", minStock: 30, reorderQty: 60 },
  ];

  for (const p of productos) {
    await prisma.product.upsert({
      where: { code: p.code },
      update: {},
      create: p,
    });
  }

  console.log(`Seed OK. Admin: ${admin.email} | Productos: ${productos.length}`);
}

main()
  .catch((error: unknown) => {
    console.error("Seed falló:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
