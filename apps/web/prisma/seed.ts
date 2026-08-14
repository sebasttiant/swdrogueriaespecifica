// Seed de desarrollo. Crea un admin con contraseña hasheada (auth Fase 2) y
// un par de productos de ejemplo para tener datos al desarrollar.
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../lib/auth/password";
import { PrismaClient } from "../lib/generated/prisma/client";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL ?? "",
});
const prisma = new PrismaClient({ adapter });

// Primer SUPERADMIN del sistema (bootstrap). El email tiene un valor por
// defecto; la contraseña NO, y es a propósito.
//
// Este repositorio es público: cualquier clave escrita acá queda publicada, y
// una instalación que no defina la suya arrancaría con un superadministrador de
// credencial conocida por cualquiera. Por eso `SEED_ADMIN_PASSWORD` es
// obligatoria.
//
// Se exige SOLO cuando hay que CREAR el administrador. Si ya existe, el seed no
// la usa —no toca su contraseña—, así que un despliegue en marcha no necesita
// definir una variable que no le hace falta.
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@ilasesorias.com";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "";
const MIN_PASSWORD_LENGTH = 12;

async function main(): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { email: ADMIN_EMAIL },
    select: { id: true },
  });

  if (existing) {
    // La contraseña NO se toca. El seed corre en cada despliegue
    // (docker-compose: `web` depende de que `seed` termine bien), así que
    // reescribirla acá borraría la rotación hecha desde la aplicación.
    //
    // `role` y `active` sí se reafirman a propósito: son la salida de
    // emergencia si el único SUPERADMIN queda desactivado o degradado por
    // error. Eso no expone la cuenta, porque sin la contraseña vigente no se
    // puede entrar.
    await prisma.user.update({
      where: { email: ADMIN_EMAIL },
      data: { role: "SUPERADMIN", active: true },
    });
  } else {
    if (ADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `SEED_ADMIN_PASSWORD es obligatoria para crear el administrador inicial (${ADMIN_EMAIL}) ` +
          `y debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres. ` +
          `Definila en el .env antes de desplegar; podés generar una con: openssl rand -base64 24`,
      );
    }

    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        name: "Super Admin",
        role: "SUPERADMIN",
        passwordHash: await hashPassword(ADMIN_PASSWORD),
      },
    });
  }

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

  console.log(
    `Seed OK. Admin: ${ADMIN_EMAIL} (${existing ? "ya existía" : "creado"}) | Productos: ${productos.length}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error("Seed falló:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
