// Seed de desarrollo. Crea un admin con contraseña hasheada (auth Fase 2) y
// un par de productos de ejemplo para tener datos al desarrollar.
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../lib/auth/password";
import { PrismaClient } from "../lib/generated/prisma/client";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL ?? "",
});
const prisma = new PrismaClient({ adapter });

// Primer SUPERADMIN del sistema (bootstrap). Email y password son configurables
// por env (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD); el fallback es para el
// entorno local. En producción SIEMPRE setear SEED_ADMIN_PASSWORD y rotar esta
// credencial. Esto NO hace exclusivo a este email: pueden crearse otros
// SUPERADMIN desde la gestión de usuarios.
const ADMIN_EMAIL =
  process.env.SEED_ADMIN_EMAIL ?? "admin@ilasesorias.com";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "Infoseg.00*2026*";

async function main(): Promise<void> {
  const passwordHash = await hashPassword(ADMIN_PASSWORD);

  // `passwordHash` va SOLO en `create`. El seed corre en cada despliegue
  // (docker-compose: `web` depende de que `seed` termine bien), así que
  // incluirlo en `update` revertía la contraseña del admin al valor de
  // SEED_ADMIN_PASSWORD cada vez que se levantaba el stack, borrando la
  // rotación hecha desde la aplicación.
  //
  // `role` y `active` sí se reafirman a propósito: son la salida de emergencia
  // si el único SUPERADMIN queda desactivado o degradado por error. Eso no
  // expone la cuenta, porque sin la contraseña vigente no se puede entrar.
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { role: "SUPERADMIN", active: true },
    create: {
      email: ADMIN_EMAIL,
      name: "Super Admin",
      role: "SUPERADMIN",
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
