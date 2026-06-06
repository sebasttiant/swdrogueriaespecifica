-- Promesa de entrega del pendiente (cuándo se le responde al cliente).
-- Obligatoria por regla de negocio, pero migración SEGURA: si ya existen filas
-- en `pendings`, se backfillea con una promesa razonable (createdAt + 24h) antes
-- de forzar NOT NULL. Así no falla con datos existentes.
ALTER TABLE "pendings" ADD COLUMN "promisedAt" TIMESTAMP(3);

UPDATE "pendings"
  SET "promisedAt" = "createdAt" + interval '24 hours'
  WHERE "promisedAt" IS NULL;

ALTER TABLE "pendings" ALTER COLUMN "promisedAt" SET NOT NULL;
