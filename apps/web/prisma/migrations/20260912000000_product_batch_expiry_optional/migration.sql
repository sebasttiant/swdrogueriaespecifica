-- El vencimiento de un lote pasa a ser OPCIONAL.
--
-- NULL = DESCONOCIDO, nunca "vencido": hay mercadería que no vence y cajas que
-- no traen la fecha impresa. Las consultas que leen stock vendible aceptan NULL
-- explícitamente; las de aviso de vencimiento lo excluyen.
--
-- Relajar una restricción no toca ninguna fila existente: las que ya tienen
-- fecha la conservan.
ALTER TABLE "product_batches" ALTER COLUMN "expiresAt" DROP NOT NULL;
