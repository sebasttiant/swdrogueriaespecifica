"use server";

import { revalidatePath } from "next/cache";

import { requireCapability } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import { addProduct } from "@/server/services/product.service";
import { productCreateSchema } from "@/features/productos/schema";
import { findProductByIdentity } from "@/server/repositories/sku-review.repository";

// --------------------------------------------------------------------------
// Server Actions de productos (finas): Zod → requireCapability → service →
// audit. Mutaciones restringidas a SUPERADMIN/ADMIN; la lectura es para
// cualquier sesión. El guard es DB-authoritative: un JWT viejo de un usuario
// degradado o desactivado no alcanza para mutar (se revalida rol/estado contra
// la base).
// --------------------------------------------------------------------------

export type ProductFormState = {
  error: string | null;
  ok: boolean;
  /**
   * El producto que YA tiene el SKU que se intentó cargar.
   *
   * Va aparte del mensaje para que la pantalla lo enlace. Decir "ese SKU ya
   * está usado" y dejar que lo busque a mano entre nombres casi idénticos
   * repite el problema que la identidad exacta existe para cerrar.
   */
  conflictingProductId?: string;
};

// P2002 (unique violation) sobre `code`. `meta.target` puede ser el array de
// campos (["code"]) o el nombre de constraint (products_code_key) según el
// driver: cubrimos ambos.
function isDuplicateCodeError(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const target = error.meta?.target;
  // Comparación EXACTA, no `includes`. El campo del SKU se llama `orionCode` y
  // su constraint `products_orionCode_key`: con una comparación por subcadena,
  // un SKU duplicado se reportaría como "ya existe un producto con ese código"
  // señalando el campo equivocado. Son dos choques distintos y la persona tiene
  // que saber cuál de los dos datos cambiar.
  if (Array.isArray(target)) return target.includes("code");
  if (typeof target === "string") return target === "products_code_key";
  return false;
}

// El otro índice único que puede chocar en el alta. Va aparte porque el
// remedio es distinto: el código interno lo elige la droguería y se puede
// inventar otro; el SKU viene de Orion y NO se cambia — si ya lo tiene otro
// producto, o son el mismo producto duplicado o alguien se equivocó de código.
function isDuplicateOrionCodeError(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes("orionCode");
  if (typeof target === "string") return target === "products_orionCode_key";
  return false;
}

export async function createProductAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  // Enforcement por capability antes de cualquier validación o efecto.
  // DB-authoritative: relee rol/estado de la base, no confía en el payload del
  // JWT (puede estar stale si degradaron/desactivaron al usuario).
  const session = await requireCapability("canManageProducts");

  const parsed = productCreateSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    unit: formData.get("unit"),
    minStock: formData.get("minStock"),
    reorderQty: formData.get("reorderQty"),
    laboratoryId: formData.get("laboratoryId") || undefined,
    orionCode: formData.get("orionCode") || undefined,
  });

  if (!parsed.success) {
    return { error: "Revisá los datos del producto.", ok: false };
  }

  try {
    const product = await addProduct(parsed.data);
    await recordAudit({
      action: AUDIT_ACTIONS.PRODUCT_CREATE,
      module: AUDIT_MODULES.PRODUCTOS,
      entity: "Product",
      entityId: product.id,
      after: parsed.data,
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    if (isDuplicateCodeError(error)) {
      return { error: "Ya existe un producto con ese código.", ok: false };
    }
    // Se nombra al producto que ya tiene ese SKU. Decir solo "está repetido"
    // deja a la persona buscándolo entre nombres parecidos, que es el error que
    // toda esta parte del sistema existe para no repetir.
    if (isDuplicateOrionCodeError(error)) {
      const holder = parsed.data.orionCode
        ? await findProductByIdentity({ orionCode: parsed.data.orionCode })
        : null;
      return {
        error: holder
          ? `Ese SKU ya lo tiene "${holder.name}". Revisá si es el mismo producto.`
          : "Ese SKU ya lo tiene otro producto.",
        ok: false,
        conflictingProductId: holder?.id,
      };
    }
    // Cualquier otro error: no se filtra al usuario, se loguea en server.
    console.error("[productos] No se pudo crear el producto:", error);
    return {
      error: "No se pudo crear el producto. Intentá de nuevo.",
      ok: false,
    };
  }

  revalidatePath("/productos");
  return { error: null, ok: true };
}
