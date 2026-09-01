-- Versión de catálogo del producto: el testigo del compare-and-set que protege
-- la edición de nombre, código interno, presentación, mínimos, laboratorio y
-- estado activo.
--
-- POR QUÉ UN ENTERO Y NO `updatedAt`.
--
-- El control de concurrencia de la edición se apoyaba en comparar `updatedAt`.
-- Eso confunde dos cosas distintas: una marca de tiempo dice CUÁNDO pasó algo,
-- no en qué ORDEN. `updatedAt` es `TIMESTAMP(3)` —resolución de milisegundo— y
-- PostgreSQL no promete que dos escrituras rápidas caigan en milisegundos
-- distintos. Si dos comparten marca, quien compara fechas concluye que nada
-- cambió y deja pasar una escritura que sí debía rechazarse: la segunda pisa a
-- la primera sin que nadie se entere.
--
-- Medirlo no alcanza como garantía. Cuarenta escrituras sin colisión son una
-- muestra, no una promesa del motor.
--
-- Un contador incrementado EN LA MISMA SENTENCIA del UPDATE no tiene ese
-- problema: `WHERE catalogVersion = N` o encuentra la fila o no, y el
-- incremento es atómico con la escritura que protege.
--
-- POR QUÉ NO SE REUSA `identityVersion`.
--
-- Esa columna es el CAS del vínculo con el código de Orion y solo la mueve ese
-- flujo. Los dos ciclos son independientes: vincular un SKU no debería
-- invalidar una corrección de nombre a medio escribir, ni al revés.
-- Compartir el contador acoplaría dos decisiones que ocurren en pantallas
-- distintas y por motivos distintos.

ALTER TABLE "products"
  ADD COLUMN "catalogVersion" INTEGER NOT NULL DEFAULT 0;

-- Las filas existentes arrancan en 0, que es exactamente lo que corresponde:
-- ninguna edición de catálogo pasó todavía por este control, y el primer
-- formulario que se abra va a leer 0 y declarar 0.
