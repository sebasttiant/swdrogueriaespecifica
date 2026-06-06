"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import { addProduct } from "@/server/services/product.service";
import { productCreateSchema } from "@/features/productos/schema";

// --------------------------------------------------------------------------
// Server Actions de productos (finas): Zod → requireRole → service → audit.
// Mutaciones restringidas a ADMIN/LIDER; la lectura es para cualquier sesión.
// --------------------------------------------------------------------------

export type ProductFormState = { error: string | null; ok: boolean };

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
  if (Array.isArray(target)) return target.includes("code");
  if (typeof target === "string") return target.includes("code");
  return false;
}

export async function createProductAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  // Enforcement de rol antes de cualquier validación o efecto.
  const session = await requireRole("ADMIN", "LIDER");

  const parsed = productCreateSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    unit: formData.get("unit"),
    minStock: formData.get("minStock"),
    reorderQty: formData.get("reorderQty"),
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
