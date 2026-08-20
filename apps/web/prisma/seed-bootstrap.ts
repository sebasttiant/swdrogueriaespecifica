import { hashPassword } from "../lib/auth/password";
import type { PrismaClient } from "../lib/generated/prisma/client";

// --------------------------------------------------------------------------
// Lógica de arranque del sistema, sin efectos al importarse.
//
// Vive separada de `seed.ts` —que es el ejecutable— por una razón concreta:
// mientras la lógica y la conexión estaban en el mismo archivo, importarlo para
// probarlo abría una conexión a la base. Por eso este código, que corre contra
// PRODUCCIÓN en cada despliegue, nunca tuvo una sola prueba.
//
// Partirlo en dos también evita el remedio habitual —un guard de
// `import.meta.url` para distinguir "me ejecutaron" de "me importaron"—, que
// falla en silencio: si el guard se equivoca, el seed no hace nada y nadie se
// entera hasta que hace falta el SUPERADMIN.
// --------------------------------------------------------------------------

/** Lo único que el arranque necesita de Prisma. */
export type SeedClient = Pick<PrismaClient, "user">;

export type SeedAdmin = {
  email: string;
  /** Solo se usa al CREAR. Si el admin ya existe, su contraseña no se toca. */
  password: string;
};

const MIN_PASSWORD_LENGTH = 12;

/**
 * Deja existiendo y habilitado al primer SUPERADMIN. Devuelve `true` si ya
 * existía.
 *
 * NO siembra productos, y no es un detalle de estilo: `deploy.sh` ejecuta el
 * seed en cada despliegue de producción. Cuando creaba tres productos de
 * ejemplo, esos productos terminaron dentro del catálogo real, indistinguibles
 * para el vendedor de uno de verdad. Los datos de demostración viven en
 * `prisma/seed-demo.ts` y en `scripts/seed-operational-data.sh`, que se
 * ejecutan a mano y a propósito.
 */
export async function runSeed(prisma: SeedClient, admin: SeedAdmin): Promise<boolean> {
  const existing = await prisma.user.findUnique({
    where: { email: admin.email },
    select: { id: true },
  });

  if (existing) {
    // `role` y `active` se reafirman a propósito: son la salida de emergencia
    // si el único SUPERADMIN queda desactivado o degradado por error. Eso no
    // expone la cuenta, porque sin la contraseña vigente no se puede entrar.
    //
    // La contraseña NO se toca. El seed corre en cada despliegue, así que
    // reescribirla acá borraría la rotación hecha desde la aplicación.
    await prisma.user.update({
      where: { email: admin.email },
      data: { role: "SUPERADMIN", active: true },
    });
    return true;
  }

  // Este repositorio es público: cualquier clave escrita acá queda publicada, y
  // una instalación que no defina la suya arrancaría con un superadministrador
  // de credencial conocida por cualquiera. Se exige SOLO al crear la cuenta: un
  // despliegue en marcha no necesita definir una variable que no le hace falta.
  if (admin.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `SEED_ADMIN_PASSWORD es obligatoria para crear el administrador inicial (${admin.email}) ` +
        `y debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres. ` +
        `Definila en el .env antes de desplegar; podés generar una con: openssl rand -base64 24`,
    );
  }

  await prisma.user.create({
    data: {
      email: admin.email,
      name: "Super Admin",
      role: "SUPERADMIN",
      passwordHash: await hashPassword(admin.password),
    },
  });
  return false;
}
