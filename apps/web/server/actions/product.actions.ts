"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { requireCapability } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import { addProduct, editProduct } from "@/server/services/product.service";
import {
  productCreateSchema,
  productUpdateSchema,
} from "@/features/productos/schema";
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
  /**
   * Eco EXACTO de lo enviado, presente SOLO cuando el guardado falla.
   *
   * React limpia los campos no controlados de un `<form action>` en cuanto la
   * acción RESUELVE —y un error devuelto es una resolución—, así que sin este
   * eco cada campo vuelve a su valor GUARDADO y se pierde la corrección. Es el
   * mismo incidente que ya golpeó al alta de pendientes, y acá duele más:
   * quien edita un producto está corrigiendo varios campos a la vez contra la
   * caja que tiene en la mano.
   */
  values?: ProductSubmittedValues;
  /**
   * Identidad de esta respuesta. El formulario se remonta con ella, que es lo
   * que hace que los campos vuelvan a leer su `defaultValue`: del eco si
   * falló, del producto guardado si salió bien.
   */
  submissionId?: string;
};

/** Lo que el formulario de edición envía, tal cual, para poder devolverlo. */
export type ProductSubmittedValues = {
  code: string;
  name: string;
  unit: string;
  minStock: string;
  reorderQty: string;
  laboratoryId: string;
  laboratoryName: string;
  active: string;
  /**
   * La versión de catálogo que corresponde a estos valores.
   *
   * Tras un FALLO es la que se envió: el reintento tiene que volver a chocar,
   * no adoptar la nueva. Tras un ÉXITO es la que quedó persistida, para que la
   * siguiente edición desde el mismo formulario use N+1.
   *
   * Viaja con el eco porque `useActionState` de este proyecto llama a
   * `router.refresh()` ante cualquier respuesta: si el campo oculto leyera la
   * versión de las props, el reintento mandaría valores viejos con un testigo
   * fresco y pasaría el control.
   */
  expectedVersion: string;
};

/** El eco: lo que vino en el FormData, sin interpretar. */
function submittedValues(formData: FormData): ProductSubmittedValues {
  const text = (key: string) => String(formData.get(key) ?? "");
  return {
    code: text("code"),
    name: text("name"),
    unit: text("unit"),
    minStock: text("minStock"),
    reorderQty: text("reorderQty"),
    laboratoryId: text("laboratoryId"),
    laboratoryName: text("laboratoryName"),
    active: formData.get("active") === "on" ? "on" : "",
    expectedVersion: text("expectedVersion"),
  };
}

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

// --------------------------------------------------------------------------
// Edición de los datos de CATÁLOGO de un producto.
//
// Lo que se puede tocar acá es identidad y política de reposición: nombre,
// código interno, presentación, mínimos, laboratorio y si sigue activo.
//
// Lo que NO se puede tocar, y no por olvido:
//
//   CANTIDADES. El stock se mueve con entradas, salidas y ajustes, que dejan
//   un movimiento auditable. Escribir "stock = 20" a mano vuelve ficción
//   cualquier cuadre posterior, porque nadie puede reconstruir de dónde salió
//   ese número. `UpdateProductData` no tiene un solo campo de cantidad: no es
//   una validación que se pueda saltear, es que no compila.
//
//   EL SKU (código de Orión). Tiene su propio circuito con control de
//   concurrencia —vincular cuando falta, corregir explícitamente cuando ya
//   existe—, porque mover una identidad que el inventario entero referencia no
//   puede ser un campo más de un formulario largo. Se edita desde la tarjeta
//   de identidad, que ya está en esta misma pantalla.
//
// La capability se revalida ACÁ. Que la pantalla esconda el botón es
// cortesía, no autorización: una Server Action es una URL, y quien la conozca
// la puede llamar sin pasar por la pantalla.
// --------------------------------------------------------------------------
export async function updateProductAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const session = await requireCapability("canManageProducts");

  const parsed = productUpdateSchema.safeParse({
    id: formData.get("id"),
    code: formData.get("code"),
    name: formData.get("name"),
    unit: formData.get("unit"),
    minStock: formData.get("minStock"),
    reorderQty: formData.get("reorderQty"),
    laboratoryId: formData.get("laboratoryId") ?? undefined,
    // El texto que quedó ESCRITO en el buscador. Sin leerlo, "escribí Genfar y
    // guardé" termina quitando el laboratorio con la pantalla mostrando Genfar.
    laboratoryName: formData.get("laboratoryName") ?? undefined,
    expectedVersion: formData.get("expectedVersion"),
    active: formData.get("active") ?? undefined,
  });

  // El eco se arma ANTES de validar: si el guardado falla, lo que la persona
  // escribió tiene que volver tal cual, incluso lo que no pasó la validación.
  const echo = submittedValues(formData);
  const failed = (error: string): ProductFormState => ({
    error,
    ok: false,
    values: echo,
    submissionId: randomUUID(),
  });

  if (!parsed.success) {
    return failed("Revisa los datos del producto.");
  }

  const { id, laboratoryName, expectedVersion, ...data } = parsed.data;

  let changed;
  try {
    changed = await editProduct(id, {
      ...data,
      laboratoryName,
      expectedVersion,
      actorId: session.user.id,
    });
  } catch (error) {
    if (isDuplicateCodeError(error)) {
      return failed("Ya existe otro producto con ese código.");
    }
    console.error("[productos] No se pudo editar el producto:", error);
    return failed("No se pudo guardar el producto. Intenta de nuevo.");
  }

  if (changed.status === "not_found") {
    return failed("Ese producto ya no existe.");
  }

  // Alguien más guardó entre que se abrió el formulario y ahora. No se pisa:
  // este formulario manda TODOS los campos, así que guardar igual reescribiría
  // con valores viejos lo que la otra persona acaba de corregir.
  if (changed.status === "stale") {
    return failed(
      "Alguien más actualizó este producto mientras lo editabas. " +
        "Recarga la pantalla para ver los datos actuales y vuelve a aplicar tus cambios.",
    );
  }

  // El nombre escrito devolvió OTRO laboratorio: pegárselo al producto sería
  // atribuirle una marca que nadie escribió.
  if (changed.status === "laboratory_unresolved") {
    return failed(
      `No se pudo resolver el laboratorio "${changed.name}". ` +
        "Elige uno de la lista o vuelve a escribirlo.",
    );
  }

  // El ANTES y el DESPUÉS, los dos. "El laboratorio ahora es Genfar" no
  // explica nada; "era Bayer y ahora es Genfar" es lo que permite entender
  // una decisión seis meses después.
  await recordAudit({
    action: AUDIT_ACTIONS.PRODUCT_UPDATE,
    module: AUDIT_MODULES.PRODUCTOS,
    entity: "Product",
    entityId: id,
    before: {
      code: changed.before.code,
      name: changed.before.name,
      unit: changed.before.unit,
      minStock: changed.before.minStock,
      reorderQty: changed.before.reorderQty,
      laboratoryId: changed.before.laboratoryId,
      active: changed.before.active,
    },
    after: {
      code: changed.after.code,
      name: changed.after.name,
      unit: changed.after.unit,
      minStock: changed.after.minStock,
      reorderQty: changed.after.reorderQty,
      laboratoryId: changed.after.laboratoryId,
      active: changed.after.active,
    },
    context: await auditContextFromHeaders(session.user.id),
  });

  revalidatePath("/productos");
  revalidatePath(`/productos/${id}`);

  // CON `values`, y esto es lo que cierra toda una clase de errores.
  //
  // La alternativa era dejar que los campos releyeran el producto de las
  // props. Pero `router.refresh()` llega DESPUÉS de la respuesta, así que el
  // remonte del éxito leía el producto viejo, y hacer que la clave dependiera
  // de la versión para releerlo abría otro agujero: un refresco disparado por
  // OTRA acción de la misma pantalla —vincular el SKU, por ejemplo— borraba
  // cualquier borrador sin enviar.
  //
  // Devolviendo lo guardado, el formulario nunca depende de cuándo llega el
  // refresco: muestra exactamente lo que quedó escrito en la base, y su
  // testigo es el de esa fila.
  return {
    error: null,
    ok: true,
    submissionId: randomUUID(),
    values: {
      code: changed.after.code,
      name: changed.after.name,
      unit: changed.after.unit,
      minStock: String(changed.after.minStock),
      reorderQty: String(changed.after.reorderQty),
      laboratoryId: changed.after.laboratoryId ?? "",
      // El nombre no está en la fila del producto; se conserva el que se envió
      // para que el buscador siga mostrando el laboratorio elegido.
      laboratoryName: echo.laboratoryName,
      active: changed.after.active ? "on" : "",
      // La versión YA INCREMENTADA: la siguiente edición desde este mismo
      // formulario declara N+1 y no vuelve a chocar contra su propio guardado.
      expectedVersion: String(changed.after.catalogVersion),
    },
  };
}
