-- Salidas rápidas de la cola de revisión de reportes.
--
-- Hasta ahora un reporte solo salía de la cola vinculándolo a un producto del
-- catálogo. Si el producto no estaba cargado, el reporte quedaba atrapado y la
-- cola solo crecía. Gerencia lee el nombre que escribió el vendedor y ya sabe
-- qué es: ahora puede marcarlo como pedido o descartarlo directamente.
--
-- Aditiva y forward-only: ninguna fila cambia de estado, y PENDING_REVIEW /
-- LINKED siguen significando exactamente lo mismo.
--
-- DEPLOYMENT NOTE (enums de PostgreSQL):
--  - `ALTER TYPE ... ADD VALUE` no se puede revertir: PostgreSQL no tiene
--    DROP VALUE. Volver atrás exige recrear el tipo.
--  - El valor nuevo no se puede USAR en la misma transacción que lo agrega, así
--    que este archivo solo agrega valores y no escribe filas.
BEGIN;

ALTER TYPE "MissingReportStatus" ADD VALUE 'ORDERED';
ALTER TYPE "MissingReportStatus" ADD VALUE 'DISCARDED';

-- Quién resolvió y cuándo. La cola la trabajan dos personas a la vez y hasta
-- ahora no se distinguía quién había marcado qué. Nullable: los reportes
-- pendientes y los ya vinculados no tienen resolución rápida que atribuir.
-- Agregar columnas NO usa los valores de enum recién creados, así que puede
-- correr en esta misma transacción sin chocar con la restricción de PostgreSQL.
ALTER TABLE "missing_reports" ADD COLUMN "resolvedById" TEXT;
ALTER TABLE "missing_reports" ADD COLUMN "resolvedAt" TIMESTAMP(3);

ALTER TABLE "missing_reports"
  ADD CONSTRAINT "missing_reports_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
