// Seed de desarrollo. Crea un admin con contraseña hasheada (auth Fase 2) y
// un par de productos de ejemplo para tener datos al desarrollar.
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../lib/auth/password";
import { PrismaClient } from "../lib/generated/prisma/client";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL ?? "",
});
const prisma = new PrismaClient({ adapter });

// Password del admin para desarrollo. Configurable por env; NUNCA usar el
// fallback en producción.
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "Especifica2026!";

async function main(): Promise<void> {
  const passwordHash = await hashPassword(ADMIN_PASSWORD);

  const admin = await prisma.user.upsert({
    where: { email: "admin@drogueriaespecifica.com" },
    update: { passwordHash },
    create: {
      email: "admin@drogueriaespecifica.com",
      name: "Administrador",
      role: "ADMIN",
      passwordHash,
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
