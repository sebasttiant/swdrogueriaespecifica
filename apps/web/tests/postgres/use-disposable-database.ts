import { randomUUID } from "node:crypto";

import { inject } from "vitest";

// Se ejecuta en cada worker ANTES de importar el archivo de test: desde acá,
// todo el código de la aplicación (que lee `DATABASE_URL`) habla con la base
// descartable de esta corrida y no con la del entorno.
process.env.DATABASE_URL = inject("disposableDatabaseUrl");

// La validación de entorno de la app (`lib/env.ts`) es fail-fast y exige un
// AUTH_SECRET de 32 caracteres o más: sin él, el cliente de Prisma no se crea.
// Se genera al vuelo, así no queda ningún secreto escrito en el repositorio, y
// no firma nada real porque en estas pruebas no hay sesiones.
process.env.AUTH_SECRET ??= `${randomUUID()}${randomUUID()}`;
