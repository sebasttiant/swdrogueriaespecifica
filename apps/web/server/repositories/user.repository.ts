// --------------------------------------------------------------------------
// Repositorio de usuarios — ÚNICO lugar que toca Prisma para `User`.
// Los services orquestan; este repo solo accede a datos.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";

// Forma mínima que auth necesita: credenciales + datos de sesión.
export type UserCredentials = {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "LIDER" | "OPERADOR";
  active: boolean;
  passwordHash: string | null;
};

export async function findActiveByEmail(
  email: string,
): Promise<UserCredentials | null> {
  return prisma.user.findFirst({
    where: { email, active: true },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      passwordHash: true,
    },
  });
}
