// --------------------------------------------------------------------------
// Qué tablas NUNCA se borran en un blanqueo operativo:
//  - `users`: decisión de negocio (los usuarios se conservan; borrarlos es
//    un acto aparte del super admin desde la UI).
//  - `_prisma_migrations`: historial de migraciones de Prisma. Borrarlo haría
//    creer a Migrate que la base nunca migró.
//
// Pura y sin dependencias para poder testear el invariante de seguridad
// ("users" jamás entra al truncate) sin tocar la base.
// --------------------------------------------------------------------------

export const WIPE_PROTECTED_TABLES = ["users", "_prisma_migrations"] as const;

export function tablesToTruncate(allTables: readonly string[]): string[] {
  const protectedTables = new Set<string>(WIPE_PROTECTED_TABLES);
  return allTables.filter((table) => !protectedTables.has(table));
}
