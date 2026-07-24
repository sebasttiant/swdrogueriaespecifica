-- Dirección de entrega del cliente en un pendiente. Opcional: la zona ya da el
-- ruteo grueso; la dirección exacta afina la entrega cuando el cliente la da.
--
-- ADITIVA y nullable: las filas existentes quedan en NULL (nadie las cargó con
-- dirección). Es PII y se minimiza server-side igual que nombre y teléfono.
ALTER TABLE "pendings" ADD COLUMN "customerAddress" TEXT;
