-- Identidad canónica de laboratorio, con UNA sola definición: la de la base.
--
-- Hasta acá la identidad la defendían dos índices que no alcanzaban:
--
--   laboratories_name_key      -- TOTAL, pero sensible a mayúsculas y espacios
--   laboratories_searchKey_key -- PARCIAL: las filas con searchKey NULL no participan
--
-- Con eso, "Bayer" (searchKey NULL) y "bayer" convivían como dos laboratorios
-- distintos, y "Lab  Doble" con "Lab Doble" también.
--
-- El primer intento de arreglo puso la regla en dos lugares —la función de
-- TypeScript y una función SQL "equivalente"— y un CHECK que las comparaba.
-- Esa equivalencia es IMPOSIBLE de sostener. Medido contra PostgreSQL 18 con
-- lc_ctype en_US.utf8:
--
--   'ΟΣ'         JS -> 03bf 03c2 (sigma FINAL)   PG -> 03bf 03c3
--   'İ'          JS -> 0069 0307 (largo 2)       PG -> 0069 (largo 1)
--   'A<U+0085>B' JS conserva U+0085              PG lo colapsa a espacio
--
-- Las dos primeras son reglas de plegado de mayúsculas que dependen de la
-- versión de Unicode y del ICU del servidor: no son reproducibles desde
-- TypeScript, y el CHECK terminaba rechazando nombres Unicode válidos.
--
-- Así que la identidad la calcula SOLO la base. La aplicación no la computa
-- para escribir: manda el nombre y la base deriva la clave. Su
-- `normalizeLaboratoryName` queda como ayuda de la pantalla, no como autoridad,
-- y que difiera en un caso exótico ya no puede crear un laboratorio duplicado.

-- ──────────────────────────────────────────────────────────────────────
-- 1. La regla, una sola vez.
--
-- Colapsar blancos, recortar, normalizar a NFC, bajar a minúsculas y volver a
-- NFC. El NFC final importa: el plegado de mayúsculas puede devolver formas
-- descompuestas, y sin él la función no sería idempotente.
--
-- El NFC además cierra un agujero que NINGUNA de las dos implementaciones
-- anteriores cubría: 'é' en un solo punto de código y 'e' + acento combinante
-- son el mismo nombre para cualquier persona, y eran dos identidades distintas.
--
-- La clase de blancos suma a [[:space:]] los blancos Unicode que no incluye:
-- NBSP, espacios tipográficos, separadores de línea y BOM.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION laboratory_canonical_identity(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $fn$
  SELECT normalize(
           lower(
             normalize(
               btrim(regexp_replace(
                 raw,
                 '[[:space:]   -     　﻿]+',
                 ' ',
                 'g'
               )),
               NFC
             )
           ),
           NFC
         )
$fn$;

COMMENT ON FUNCTION laboratory_canonical_identity(text) IS
  'Identidad canonica de un laboratorio y UNICA autoridad: colapsa blancos, recorta, normaliza a NFC y baja a minusculas. La aplicacion no la replica.';

-- ──────────────────────────────────────────────────────────────────────
-- 2. Guarda: si la base ya trae identidades duplicadas, esta migración FALLA.
--
-- No elige, no borra y no reasigna nada. Cuál fila sobrevive y a dónde apuntan
-- sus relaciones es una decisión de negocio, no de una migración: un
-- `products.laboratoryId` movido por un algoritmo es evidencia perdida.
-- ──────────────────────────────────────────────────────────────────────

DO $guard$
DECLARE
  duplicados text;
BEGIN
  SELECT string_agg(
           format('%L <- %s', identidad, nombres),
           E'\n  '
           ORDER BY identidad
         )
    INTO duplicados
    FROM (
      SELECT laboratory_canonical_identity(name) AS identidad,
             string_agg(quote_literal(name), ', ' ORDER BY name) AS nombres
        FROM laboratories
       GROUP BY 1
      HAVING count(*) > 1
    ) grupos;

  IF duplicados IS NOT NULL THEN
    RAISE EXCEPTION
      'laboratories: hay identidades canonicas duplicadas, la migracion no continua:%  %',
      E'\n', duplicados
      USING HINT =
        'Resolve a mano que fila queda y a donde apuntan sus relaciones antes de migrar. Esta migracion nunca elige, borra ni reasigna filas.';
  END IF;
END
$guard$;

-- ──────────────────────────────────────────────────────────────────────
-- 3. `searchKey` pasa a ser derivado por la base.
--
-- El DEFAULT existe para que quien inserte no tenga que mandar la columna; el
-- trigger la pisa siempre, así que el valor por defecto nunca sobrevive.
--
-- Se vacía y se vuelve a llenar en dos pasos porque el índice único de
-- `searchKey` se evalúa fila por fila: reescribir en un solo UPDATE puede
-- chocar contra un valor que otra fila todavía no soltó. Con todo en NULL no
-- hay choque posible, porque el índice de este momento todavía es parcial.
-- ──────────────────────────────────────────────────────────────────────

UPDATE laboratories SET "searchKey" = NULL;
UPDATE laboratories SET "searchKey" = laboratory_canonical_identity(name);

ALTER TABLE laboratories
  ALTER COLUMN "searchKey" SET DEFAULT '',
  ALTER COLUMN "searchKey" SET NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- 4. El trigger que la mantiene.
--
-- Corre en INSERT y en UPDATE, así que `searchKey` no puede quedar desalineada
-- del nombre ni siquiera si alguien inserta directo por psql mandando otro
-- valor. La aplicación deja de calcularla.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION laboratories_set_canonical_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $trg$
BEGIN
  NEW."searchKey" := laboratory_canonical_identity(NEW.name);
  RETURN NEW;
END
$trg$;

CREATE TRIGGER laboratories_canonical_identity_sync
  BEFORE INSERT OR UPDATE OF name, "searchKey" ON laboratories
  FOR EACH ROW
  EXECUTE FUNCTION laboratories_set_canonical_identity();

-- ──────────────────────────────────────────────────────────────────────
-- 5. El índice que hace cumplir la identidad.
--
-- El que existía era PARCIAL —`WHERE "searchKey" IS NOT NULL`— y con la
-- columna ya NOT NULL esa condición sobra. Se reemplaza por uno total para que
-- el plan no dependa de una cláusula que siempre es verdadera.
-- ──────────────────────────────────────────────────────────────────────

DROP INDEX "laboratories_searchKey_key";

CREATE UNIQUE INDEX "laboratories_searchKey_key"
  ON laboratories ("searchKey");

-- ──────────────────────────────────────────────────────────────────────
-- 6. El CHECK, como aserción.
--
-- Con el trigger nunca debería poder fallar. Está para que, si alguien
-- desactivara el trigger, la inconsistencia se vea en el acto y no seis meses
-- después. Llama a la MISMA función: no es una segunda definición de la regla.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE laboratories
  ADD CONSTRAINT "laboratories_searchKey_canonical_check"
  CHECK ("searchKey" = laboratory_canonical_identity(name));
