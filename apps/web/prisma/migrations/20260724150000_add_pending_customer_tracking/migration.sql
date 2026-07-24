-- Seguimiento del cliente en un pendiente: zona de entrega y estado de pago.
--
-- ADITIVA y no destructiva. `zone` y `totalAmount` quedan NULL en las filas
-- existentes (no se infieren: no hay dato del cual deducirlos). `paidAmount`
-- entra NOT NULL con DEFAULT 0, que es la verdad para todo pendiente anterior:
-- ninguno registró abono, así que cero no inventa información.
ALTER TABLE "pendings" ADD COLUMN "zone" TEXT;
ALTER TABLE "pendings" ADD COLUMN "totalAmount" INTEGER;
ALTER TABLE "pendings" ADD COLUMN "paidAmount" INTEGER NOT NULL DEFAULT 0;

-- Integridad en la base, no solo en la app. Misma técnica aditiva que
-- `missing_items_ordered_quantity_positive` (Prisma no expresa CHECK en el DSL).
--
-- Un total acordado, si existe, es positivo: un valor de cero o negativo no es
-- un precio, es un error de carga.
ALTER TABLE "pendings"
  ADD CONSTRAINT "pendings_total_amount_positive"
  CHECK ("totalAmount" IS NULL OR "totalAmount" > 0);

-- El abono nunca es negativo. No se restringe contra `totalAmount`: un abono
-- mayor al total es plata a favor del cliente (vuelto), no una violación de
-- integridad. El formulario sí lo rechaza al cargarlo, porque ahí es un typo.
ALTER TABLE "pendings"
  ADD CONSTRAINT "pendings_paid_amount_nonneg"
  CHECK ("paidAmount" >= 0);
