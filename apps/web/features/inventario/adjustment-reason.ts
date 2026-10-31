// --------------------------------------------------------------------------
// Por qué se corrige el stock de un lote.
//
// Lista CERRADA a propósito. Un campo de texto libre deja constancia de que
// alguien escribió algo, pero no permite responder después "¿cuánta mercadería
// perdimos por merma este mes?" ni distinguir un error de carga de una
// diferencia real de conteo. La nota libre existe aparte, para el detalle.
//
// `CAUSA_DESCONOCIDA` no es un descuido de diseño: es la opción honesta. Sin
// ella, quien encuentra una diferencia que no puede explicar elige el motivo
// que menos le incomoda, y el registro queda peor que vacío — queda mintiendo.
// --------------------------------------------------------------------------

export const ADJUSTMENT_REASONS = [
  "CONTEO_FISICO",
  "MERMA",
  "ERROR_CARGA",
  "CAUSA_DESCONOCIDA",
] as const;

export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  CONTEO_FISICO: "Diferencia detectada en conteo físico",
  MERMA: "Merma: producto dañado, roto o descartado",
  ERROR_CARGA: "Error al registrar una entrada",
  CAUSA_DESCONOCIDA: "Diferencia sin causa conocida",
};

export function isAdjustmentReason(value: unknown): value is AdjustmentReason {
  return (
    typeof value === "string" &&
    (ADJUSTMENT_REASONS as readonly string[]).includes(value)
  );
}
