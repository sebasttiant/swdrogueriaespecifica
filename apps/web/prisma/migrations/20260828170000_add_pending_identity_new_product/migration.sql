-- Motivo de aplazamiento faltante: el producto es NUEVO y todavía no tiene SKU.
--
-- Los cuatro motivos existentes describen un FRACASO al conseguir el código:
-- Orion no responde, no lo encuentro, ya está en otro producto, otro motivo.
-- Ninguno describe el caso legítimo y frecuente: el producto acaba de entrar y
-- todavía no tiene código en Orion porque nadie se lo creó.
--
-- Que ese caso cayera en "Otro motivo" es justamente lo que la lista cerrada
-- existe para evitar: mezclado con el resto, la cola de revisión no puede
-- distinguir "Orion se está cayendo seguido" de "estamos dando de alta productos
-- nuevos", que piden acciones opuestas.
--
-- Aditivo y sin backfill: las filas que ya eligieron OTHER se conservan como
-- fueron. Reinterpretarlas sería reescribir lo que la persona dijo.

ALTER TYPE "PendingIdentityDeferral" ADD VALUE IF NOT EXISTS 'NEW_PRODUCT';
