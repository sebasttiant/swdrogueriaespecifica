-- Teléfono del cliente en un pendiente. Gerencia lo pidió como dato
-- obligatorio: sin teléfono no hay forma de avisar que el producto llegó.
--
-- ADITIVA y NULLABLE a propósito. La obligatoriedad vive en el formulario y en
-- el schema de validación, NO en la columna: marcarla NOT NULL exigiría
-- inventarle un teléfono a cada pendiente ya registrado, y la base pasaría a
-- afirmar algo falso sobre el pasado. La regla nueva rige hacia adelante; las
-- filas anteriores se muestran como "sin teléfono registrado".
ALTER TABLE "pendings" ADD COLUMN "customerPhone" TEXT;
