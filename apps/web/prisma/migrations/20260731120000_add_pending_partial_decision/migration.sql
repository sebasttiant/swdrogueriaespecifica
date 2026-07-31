-- Qué respondió el cliente sobre lo que faltó de una entrega parcial.
--
-- Hasta ahora "espera el resto" y "va con otro pedido" solo dejaban una nota.
-- El pendiente seguía PARCIAL con unidades sin entregar, así que la pantalla
-- volvía a preguntar lo mismo una y otra vez: la respuesta se guardaba, pero
-- nada permitía saber que ya se había dado. Solo "no los espera" parecía
-- funcionar, porque esa cierra el pendiente.
--
-- Solo se registran las respuestas que dejan el pendiente ABIERTO. "No los
-- espera" no necesita columna: se ve en el estado.
--
-- Aditiva y forward-only: las filas existentes quedan en NULL, es decir sin
-- responder. Es lo correcto —a nadie se le preguntó todavía—, y la pregunta
-- aparecerá cuando corresponda.
CREATE TYPE "PendingPartialDecision" AS ENUM ('ESPERA', 'VA_CON_PEDIDO');

ALTER TABLE "pendings"
  ADD COLUMN "partialDecision" "PendingPartialDecision",
  ADD COLUMN "partialDecisionAt" TIMESTAMP(3);
