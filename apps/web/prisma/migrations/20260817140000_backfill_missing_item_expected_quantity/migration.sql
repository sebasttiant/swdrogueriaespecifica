-- Backfill de la cantidad ESPERADA en los pedidos anteriores a D10.
--
-- Antes de D10 el chulito "Ya lo pedí" dejaba `orderedQuantity` en NULL a
-- propósito: el gerente no declara cantidad. El problema es que sin ese número
-- no hay contra qué comparar lo recibido, así que un pedido nunca podía saberse
-- completo y se quedaba en la cola para siempre.
--
-- Desde D10 el chulito la deriva de `quantity` al escribir. Esto hace lo mismo,
-- una sola vez, con las filas que ya estaban.
--
-- Qué NO toca, y es deliberado:
--   * Filas con `orderedQuantity` ya cargada: alguien la declaró en el
--     formulario completo, y una derivación no pisa lo que una persona escribió.
--   * `quantity` <= 0: no es una cantidad. Se deja en NULL para que caiga en
--     revisión en vez de inventarle un número (el CHECK las rechazaría igual).
--   * Cualquier estado que no sea PEDIDO. Un FALTANTE sin pedir no tiene
--     cantidad esperada porque todavía no se pidió nada, y RECIBIDO/CANCELADO
--     ya están cerrados: reescribirlos cambiaría historia.
--
-- Es IDEMPOTENTE: el `WHERE "orderedQuantity" IS NULL` hace que una segunda
-- corrida no encuentre nada que hacer. Y es transaccional por defecto, así que
-- si algo falla no queda a medias.

-- Conteo ANTES. Queda en el log de la migración para poder contrastarlo.
DO $$
DECLARE
  pendientes INT;
BEGIN
  SELECT count(*) INTO pendientes
  FROM missing_items
  WHERE status = 'PEDIDO' AND "orderedQuantity" IS NULL AND quantity > 0;

  RAISE NOTICE 'backfill cantidad esperada — filas a completar: %', pendientes;
END $$;

UPDATE missing_items
SET "orderedQuantity" = quantity
WHERE status = 'PEDIDO'
  AND "orderedQuantity" IS NULL
  AND quantity > 0;

-- Conteo DESPUÉS. Si quedó alguna fila PEDIDO sin cantidad esperada es porque
-- su `quantity` no era una cantidad: se avisa en vez de esconderlo.
DO $$
DECLARE
  restantes INT;
BEGIN
  SELECT count(*) INTO restantes
  FROM missing_items
  WHERE status = 'PEDIDO' AND "orderedQuantity" IS NULL;

  IF restantes > 0 THEN
    RAISE NOTICE 'backfill: quedan % pedido(s) sin cantidad esperada (quantity <= 0). Requieren revisión manual.', restantes;
  ELSE
    RAISE NOTICE 'backfill: no queda ningún pedido sin cantidad esperada.';
  END IF;
END $$;
