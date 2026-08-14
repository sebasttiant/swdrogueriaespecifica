import { inject } from "vitest";

// Se ejecuta en cada worker ANTES de importar el archivo de test: desde acá,
// todo el código de la aplicación (que lee `DATABASE_URL`) habla con la base
// descartable de esta corrida y no con la del entorno.
process.env.DATABASE_URL = inject("disposableDatabaseUrl");
