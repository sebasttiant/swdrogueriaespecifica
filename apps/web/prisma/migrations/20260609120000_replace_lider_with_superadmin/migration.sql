-- Corrección del modelo de roles: el negocio no usa LIDER.
-- Se elimina 'LIDER' y se agrega 'SUPERADMIN' al enum UserRole.
--
-- AlterEnum: recrear el tipo (Postgres no permite DROP VALUE de un enum).
BEGIN;

-- Los usuarios LIDER existentes se migran a OPERADOR (menor privilegio) ANTES
-- del swap de tipo: 'LIDER' deja de existir, y el cast directo fallaría si
-- quedara alguna fila con ese valor.
UPDATE "users" SET "role" = 'OPERADOR' WHERE "role" = 'LIDER';

CREATE TYPE "UserRole_new" AS ENUM ('SUPERADMIN', 'ADMIN', 'OPERADOR');
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole_new" USING ("role"::text::"UserRole_new");
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
DROP TYPE "UserRole_old";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'OPERADOR';
COMMIT;
