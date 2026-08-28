-- Identidad canónica de laboratorio, defendida por el ESQUEMA.
--
-- Hasta acá la identidad la defendían dos índices que no alcanzaban:
--
--   laboratories_name_key      -- TOTAL, pero sensible a mayúsculas y espacios
--   laboratories_searchKey_key -- PARCIAL: las filas con searchKey NULL no participan
--
-- Con eso, "Bayer" (searchKey NULL) y "bayer" conviven como dos laboratorios
-- distintos, y "Lab  Doble" con "Lab Doble" también. El dominio los considera
-- LA MISMA identidad —normalizeLaboratoryName hace trim, minúsculas y colapso
-- de espacios—, así que la base contradecía al dominio.
--
-- La regla ahora vive en la base, en UN solo lugar, y el índice la aplica. No
-- depende de que la aplicación escriba bien `searchKey`: aunque lo escribiera
-- mal, el índice sigue midiendo `name`.

-- ──────────────────────────────────────────────────────────────────────
-- 1. La regla, como función IMMUTABLE.
--
-- Réplica exacta de `normalizeLaboratoryName`: colapsar blancos, recortar
-- extremos, minúsculas. En ese orden — colapsar primero convierte tabs y
-- saltos en espacios, y recién ahí btrim los puede recortar.
--
-- La clase de blancos es la de \s de JavaScript, que es MÁS ancha que la de
-- PostgreSQL: [[:space:]] cubre tab, salto, retorno, form feed y tabulación
-- vertical, y se le suman a mano los blancos Unicode que JS incluye (NBSP,
-- espacios tipográficos, separadores de línea y BOM). Sin ese agregado la
-- base y la aplicación normalizarían distinto, y una identidad duplicada se
-- colaría por un espacio invisible.
--
-- `tests/postgres/laboratory-canonical-identity.pg.test.ts` compara las dos
-- implementaciones caso por caso para que no se separen nunca.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION laboratory_canonical_identity(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $fn$
  SELECT lower(btrim(regexp_replace(
    raw,
    '[[:space:]   -     　﻿]+',
    ' ',
    'g'
  )))
$fn$;

COMMENT ON FUNCTION laboratory_canonical_identity(text) IS
  'Identidad canonica de un laboratorio: colapsa blancos, recorta y baja a minusculas. Replica exacta de normalizeLaboratoryName en apps/web/server/domain/laboratory/identity.ts.';

-- ──────────────────────────────────────────────────────────────────────
-- 2. Guarda: si la base ya trae identidades duplicadas, esta migración FALLA.
--
-- No elige, no borra y no reasigna nada. Cuál fila sobrevive y a dónde
-- apuntan sus relaciones es una decisión de negocio, no de una migración: un
-- `products.laboratoryId` movido por un algoritmo es evidencia perdida.
--
-- El mensaje nombra cada grupo en conflicto para que se resuelva a mano.
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
      'laboratories: hay identidades canonicas duplicadas, la migracion no continua:%s  %s',
      E'\n  ', duplicados
      USING HINT =
        'Resolve a mano que fila queda y a donde apuntan sus relaciones antes de migrar. Esta migracion nunca elige, borra ni reasigna filas.';
  END IF;
END
$guard$;

-- ──────────────────────────────────────────────────────────────────────
-- 3. `searchKey` queda alineado con la regla.
--
-- Se vacía primero y se rellena después, en dos pasos, porque el índice único
-- parcial de `searchKey` se evalúa fila por fila: reescribir en un solo UPDATE
-- puede chocar contra un valor que otra fila todavía no soltó. Con todo en
-- NULL no hay choque posible — el índice es parcial y los NULL no participan.
--
-- Después de la guarda del paso 2 sabemos que los valores finales son todos
-- distintos, así que el relleno no puede violar nada.
-- ──────────────────────────────────────────────────────────────────────

UPDATE laboratories SET "searchKey" = NULL;
UPDATE laboratories SET "searchKey" = laboratory_canonical_identity(name);

ALTER TABLE laboratories
  ALTER COLUMN "searchKey" SET NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- 4. El índice que hace cumplir la identidad.
--
-- Sobre la expresión y no sobre la columna: mide `name` directamente, así que
-- un bug de la aplicación escribiendo `searchKey` no puede abrirle la puerta a
-- una identidad duplicada.
-- ──────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "laboratories_canonical_identity_key"
  ON laboratories (laboratory_canonical_identity(name));

-- ──────────────────────────────────────────────────────────────────────
-- 5. `searchKey` derivado, verificado por la base.
--
-- Con el CHECK, `searchKey` no puede separarse de `name`. Deja de ser un dato
-- que la aplicación mantiene por disciplina y pasa a ser uno que la base
-- garantiza.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE laboratories
  ADD CONSTRAINT "laboratories_searchKey_canonical_check"
  CHECK ("searchKey" = laboratory_canonical_identity(name));
