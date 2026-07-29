-- Código operativo opcional del vendedor que envía el reporte de faltante.
--
-- ADITIVA y nullable: los reportes existentes no tenían este dato, por lo que
-- quedan en NULL. El código es texto libre de negocio, no una relación con User;
-- la identidad del reportante ya vive en `reporterId`.
ALTER TABLE "missing_reports" ADD COLUMN "sellerCode" TEXT;
