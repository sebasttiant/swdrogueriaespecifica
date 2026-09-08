-- ---------------------------------------------------------------------------
-- QUÉ HABÍA DETRÁS DEL NÚMERO DEL CHIP.
--
-- Solo lee y solo devuelve conteos: ni un nombre de cliente, ni un teléfono, ni
-- una dirección. Se puede correr contra producción sin exponer nada.
--
--   docker compose exec -T db psql -U <usuario> -d <base> \
--     -f /dev/stdin < scripts/diagnostico-pedidos-sin-conseguir.sql
--
-- Sirve para dos cosas: ver cuánto del número viejo era trabajo fantasma, y
-- confirmar después del deploy que el número nuevo cuenta lo que tiene que
-- contar.
-- ---------------------------------------------------------------------------

\echo '== 1. Faltantes de pedido de cliente, abiertos, por estado del pedido =='

-- El universo: rieles abiertos y sin confirmar nacidos de un pedido de cliente.
-- Es exactamente lo que miraba el contador viejo, abierto por los dos ejes de
-- estado del pendiente que lo originó.
SELECT
  pe."status"          AS estado_pedido,
  pe."purchaseStatus"  AS estado_compra,
  COUNT(*)                                                    AS faltantes,
  COUNT(*) FILTER (WHERE pe."promisedAt" < now())             AS vencidos,
  COUNT(*) FILTER (WHERE pe."promisedAt" >= now())            AS al_dia
FROM missing_items mi
JOIN pendings pe ON pe.id = mi."originId"
WHERE mi."status" IN ('FALTANTE', 'PEDIDO')
  AND mi."confirmedAt" IS NULL
GROUP BY 1, 2
ORDER BY vencidos DESC, faltantes DESC;

\echo ''
\echo '== 2. El número del chip: antes y después del arreglo =='

-- ANTES contaba todo lo vencido sin mirar el pedido. DESPUÉS excluye los tres
-- terminales y el agotado —que vive en dos columnas: `status` en las filas
-- previas a la migración 20260730230000 y `purchaseStatus` en las nuevas—.
SELECT
  COUNT(*) AS chip_antes,
  COUNT(*) FILTER (
    WHERE pe."status" NOT IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL', 'AGOTADO')
      AND pe."purchaseStatus" <> 'AGOTADO'
  ) AS chip_despues,
  COUNT(*) FILTER (
    WHERE pe."status" IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL', 'AGOTADO')
       OR pe."purchaseStatus" = 'AGOTADO'
  ) AS trabajo_fantasma
FROM missing_items mi
JOIN pendings pe ON pe.id = mi."originId"
WHERE mi."status" IN ('FALTANTE', 'PEDIDO')
  AND mi."confirmedAt" IS NULL
  AND pe."promisedAt" < now();

\echo ''
\echo '== 3. El chip "Atrasadas": el agotado que se le colaba =='

-- La exclusión del agotado estaba escrita mirando solo `status`, y desde la
-- migración que separó los ejes gerencia lo marca en `purchaseStatus`. Todo lo
-- que aparezca en `agotados_que_contaban` era un pedido dado por perdido que
-- seguía pintado de rojo.
SELECT
  COUNT(*) FILTER (
    WHERE pe."status" NOT IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL', 'AGOTADO')
  ) AS atrasadas_antes,
  COUNT(*) FILTER (
    WHERE pe."status" NOT IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL', 'AGOTADO')
      AND pe."purchaseStatus" <> 'AGOTADO'
  ) AS atrasadas_despues,
  COUNT(*) FILTER (
    WHERE pe."status" NOT IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL', 'AGOTADO')
      AND pe."purchaseStatus" = 'AGOTADO'
  ) AS agotados_que_contaban
FROM pendings pe
WHERE pe."promisedAt" < now();
