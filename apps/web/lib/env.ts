import { z } from "zod";

// --------------------------------------------------------------------------
// Validación de entorno con fail-fast.
// Se valida de forma perezosa (al primer uso en runtime de servidor), NO en
// build, para que `next build` y `tsc` no necesiten secretos reales.
// --------------------------------------------------------------------------

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    // Fail-fast: si faltan secrets obligatorios, no arrancamos.
    throw new Error(
      `Configuración de entorno inválida (fail-fast):\n${issues}`,
    );
  }

  cached = parsed.data;
  return cached;
}
