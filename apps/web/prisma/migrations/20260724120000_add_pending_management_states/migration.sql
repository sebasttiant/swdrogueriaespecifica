-- Mejora 2: estados de gestión que gerencia/compras fija sobre un pendiente
-- abierto para comunicarle al vendedor en qué punto está la búsqueda del
-- producto (solicitado → búsqueda → cotizando → agotado).
--
-- ADITIVA y no destructiva: solo agrega valores al enum. No renombra ni elimina
-- los existentes, así que las filas actuales (PENDIENTE/PARCIAL/ENTREGADO/
-- CANCELADO) quedan intactas. AGOTADO no cancela el pendiente: es una señal; la
-- cancelación la sigue haciendo el vendedor por el flujo de siempre.
--
-- AlterEnum: agregar más de un valor a un enum en una sola migración requiere
-- PostgreSQL 12+ (este proyecto corre 18). En 11 y anteriores habría que partir
-- en una migración por valor.
ALTER TYPE "PendingStatus" ADD VALUE 'SOLICITADO';
ALTER TYPE "PendingStatus" ADD VALUE 'BUSQUEDA';
ALTER TYPE "PendingStatus" ADD VALUE 'COTIZANDO';
ALTER TYPE "PendingStatus" ADD VALUE 'AGOTADO';
