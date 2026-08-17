# Runbook de restauración

Procedimiento para recuperar la base de datos de Droguería Específica.

El paso 3 —restaurar un respaldo y verificarlo— está ENSAYADO de punta a punta
contra una copia descartable con `scripts/restore-drill.sh`, y ese ensayo se
puede repetir cuando quieras. El paso 4 corre los mismos comandos de `psql`
contra la base real; lo que no se puede ensayar es el destino.

**Compromisos vigentes (decisión D1)**

| | Valor | Qué significa |
|---|---|---|
| RPO | 24 h | Se acepta perder hasta un día de operación. Los respaldos son diarios. |
| RTO | 4 h | Desde que se decide restaurar hasta que la operación vuelve. |

Las 4 h del RTO son el presupuesto TOTAL: incluye diagnosticar, elegir el
respaldo, probarlo aislado y recién ahí restaurar. Por eso el paso 3 no es
opcional — restaurar un dump roto y descubrirlo a mitad de camino es lo único
que garantiza incumplir el RTO.

## 1. ¿Hay que restaurar?

Restaurar es destructivo: reemplaza el estado actual y todo lo ocurrido desde
el respaldo se pierde. Antes de llegar ahí:

```
¿La base responde?
├─ NO  → ¿el contenedor está caído?
│        ├─ SÍ → `docker compose up -d postgres`. Si levanta, NO restaures.
│        └─ NO → ¿disco lleno? `df -h`. Liberá espacio. Si levanta, NO restaures.
│                 Si el volumen está corrupto → RESTAURAR.
└─ SÍ  → ¿los datos están mal?
         ├─ Faltan filas / borrado accidental → RESTAURAR.
         ├─ Inventario descuadrado → NO restaures todavía: corré
         │  `db:reconcile` (paso 4). Un descuadre se corrige con asientos,
         │  no tirando abajo un día de trabajo.
         └─ Lentitud o errores de la app → no es un problema de datos.
```

**Regla**: ante la duda, no restaures. Un dato viejo recuperable es mejor que
un día de operación perdido por las dudas.

## 2. Elegir el respaldo

Los respaldos los genera `scripts/backup-data.sh` en `backups/data/` como
`drogueria-data-backup-<fecha>-<hora>.tar.gz`.

```bash
ls -lt backups/data/ | head
```

Elegí **el más reciente ANTERIOR al problema**. Si el borrado fue a las 14:00,
sirve el de las 02:00 de ese día, no el de las 23:00. Si no sabés cuándo
empezó el problema, empezá por el más reciente: el paso 3 te dice si sirve.

## 3. Probar el respaldo AISLADO (obligatorio)

Nunca se restaura en producción un respaldo que no se probó. Este paso no toca
nada real: levanta un PostgreSQL aparte, restaura ahí y verifica.

```bash
pnpm data:restore:drill --dump=backups/data/drogueria-data-backup-<fecha>.tar.gz
```

Qué hace: extrae el SQL, levanta un PostgreSQL descartable, restaura con
`ON_ERROR_STOP=1`, cuenta las filas de cada tabla y corre el reconciliador de
inventario. Al terminar destruye todo lo que creó.

- **`ENSAYO OK`** → el respaldo sirve. Seguí al paso 4.
- **`ENSAYO FALLIDO`** → mirá por qué:
  - error de SQL durante el restore → el archivo está corrupto. Probá el
    respaldo anterior.
  - restaura pero el inventario no cuadra → ese descuadre viaja DENTRO del
    respaldo. Restaurarlo reproduce el problema. Probá uno anterior, o seguí
    con `--allow-drift` solo si entendés la lista de lotes que imprimió.
- Para inspeccionar la copia a mano, agregá `--keep` y te deja la conexión.

Revisá los conteos: una tabla en 0 que debería tener datos es la señal de que
el respaldo se tomó mal, aunque el restore no dé error.

## 4. Restaurar en producción

Recién con el paso 3 en verde.

```bash
# 4.1 Respaldo del estado ACTUAL, por roto que parezca. Es tu vuelta atrás.
bash scripts/backup-data.sh

# 4.2 Bajar la app para que nadie escriba durante la restauración.
docker compose stop web

# 4.3 Extraer el SQL del respaldo elegido.
tar -xzf backups/data/drogueria-data-backup-<fecha>.tar.gz -C /tmp
SQL=/tmp/drogueria-data-backup-<fecha>/postgres.sql

# 4.4 Recrear la base vacía y restaurar.
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE \"$POSTGRES_DB\" WITH (FORCE);" -c "CREATE DATABASE \"$POSTGRES_DB\";"
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$SQL"

# 4.5 Levantar la app.
docker compose up -d web
```

`ON_ERROR_STOP=1` va en los dos comandos a propósito: sin él `psql` informa el
error, sigue adelante y te deja una base a medio restaurar que parece sana.

## 5. Verificar antes de decir que terminó

```bash
# Conteos: comparalos contra los que imprimió el ensayo del paso 3.
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM pendings;" -c "SELECT count(*) FROM missing_items;"

# Inventario contra el ledger. Sale con código 0 si cuadra.
pnpm --filter @drogueria/web db:reconcile

# La app responde.
curl -fsS http://127.0.0.1:3132/api/health && echo OK
```

Y probá a mano un login y una pantalla con datos. Un `/api/health` en verde
solo dice que el proceso vive, no que la operación sirva.

## 6. Ensayo trimestral (decisión D7)

Cada trimestre, sobre el respaldo más reciente:

```bash
pnpm data:restore:drill --dump=backups/data/<el más reciente>
```

Asentá la fecha, el respaldo usado y el resultado. Si falla, es un incidente
aunque no haya nadie afectado: significa que hoy no podríamos recuperarnos.
