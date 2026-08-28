import type { SkuIdentityCode } from "@/server/domain/catalog/sku-identity";

// --------------------------------------------------------------------------
// Del código del dominio al mensaje del operador.
//
// El tipo `Record<SkuIdentityCode, string>` es el que hace el trabajo: si
// mañana el dominio agrega un código, esto NO compila. Un `switch` con
// `default` o un objeto suelto se lo tragarían en silencio y la pantalla
// mostraría el mensaje genérico para una causa que sí sabemos explicar.
//
// Cada mensaje dice qué pasó Y qué hacer. "No se pudo vincular" a secas deja
// al operador reintentando lo mismo.
// --------------------------------------------------------------------------

export const SKU_IDENTITY_MESSAGES: Record<SkuIdentityCode, string> = {
  AMBIGUOUS_MODE:
    "Llegaron dos formas de identificar el producto a la vez y no se puede elegir por vos. Volvé a entrar desde el producto.",
  FORBIDDEN_ACTOR: "Tu perfil no puede asignar la identidad de un producto.",
  MISSING_EXACT_IDENTITY:
    "El SKU (código de Orion) no es válido: máximo 80 caracteres, no vacío y sin espacios.",
  UNKNOWN_SKU:
    "Ese producto ya no está en el catálogo. Refrescá la pantalla y volvé a intentar.",
  ID_SKU_MISMATCH:
    "Los datos del formulario apuntan a dos productos distintos. Refrescá la pantalla y volvé a intentar.",
  ORION_CONFLICT:
    "Ese SKU (código de Orion) ya está en uso por otro producto, o este producto ya tiene uno. El código no se pisa: mudarlo es una decisión aparte.",
  GENERATION_EXHAUSTED:
    "El sistema no pudo acuñar un código interno tras varios intentos. Probá de nuevo en un momento.",
};

// Perder el compare-and-set NO es un `SkuIdentityError`: lo lanza
// `SkuConcurrencyError`, de otra clase, y significa algo distinto de todo lo
// demás. Nada de lo que escribió el operador está mal — otro llegó primero—,
// así que el mensaje no lo manda a corregir nada, lo manda a mirar de nuevo.
export const SKU_IDENTITY_CONCURRENCY_MESSAGE =
  "Otra persona cambió la identidad de este producto mientras lo editabas. Refrescá para ver cómo quedó antes de volver a intentarlo.";

// Deliberadamente distinto de los siete de arriba: si el operador ve ESTE
// texto, la causa no es ninguna que sepamos nombrar, y eso hay que poder
// distinguirlo al leer un reporte de soporte.
const UNKNOWN_CAUSE =
  "No se pudo guardar el código. Intentá de nuevo; si sigue, avisá a soporte.";

export function messageForIdentityError(code: SkuIdentityCode | undefined): string {
  if (code === undefined) return UNKNOWN_CAUSE;

  return SKU_IDENTITY_MESSAGES[code] ?? UNKNOWN_CAUSE;
}
