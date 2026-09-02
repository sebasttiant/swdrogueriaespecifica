"use client";

import Link from "next/link";

import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { LaboratorySearch } from "@/features/productos/laboratory-search";
import {
  createProductAction,
  type ProductFormState,
} from "@/server/actions/product.actions";

const INITIAL_STATE: ProductFormState = { error: null, ok: false };

// Alta de producto. La página decide el montaje con canManageProducts.
export function ProductForm() {
  const [state, formAction, isPending] = useActionState(
    createProductAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Este NO es el SKU. Es el código interno del catálogo —`PROV-…`,
            `MED-001`— y no existe del otro lado, en Orion. Decía solo "Código",
            y esa ambigüedad es la misma que hizo elegir el producto equivocado
            al registrar una entrada: tres nombres parecidos y un código que no
            identifica nada fuera de acá.

            El SKU va en el campo de al lado. Antes no estaba, con el
            argumento de que acuñar identidad acá salteaba las garantías del
            flujo propio. No las saltea: la unicidad la impone el índice único
            de la base —más fuerte que cualquier chequeo previo—, la
            inmutabilidad no aplica sobre algo que todavía no existe, y cambiar
            un SKU ya cargado sigue pasando por su flujo. El repositorio
            argumenta lo contrario del comentario que estaba acá: "un producto
            que nace con su identidad nunca existe —ni por un instante— sin
            ella", y `pending.service.ts` ya lo crea así. */}
        <Field label="Código interno" htmlFor="code">
          <Input id="code" name="code" required />
        </Field>
        {/* Sin este campo TODO producto nuevo nacía sin identidad: caía en
            la cola de "Revisión de identidad" y bloqueaba la entrada cuando
            llegaba la caja. El alta fabricaba el problema que el rechazo de la
            entrada existe para atajar.

            Opcional, porque el producto nuevo sin código todavía existe y
            exigirlo cerraría un alta legítima. */}
        <Field label="SKU (código de Orión)" htmlFor="orionCode">
          <Input
            id="orionCode"
            name="orionCode"
            placeholder="Como figura en Orión"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Si todavía no lo tenés, dejalo vacío y completalo después.
          </p>
        </Field>
        <Field label="Nombre" htmlFor="name">
          <Input id="name" name="name" required />
        </Field>
        <Field label="Presentación / unidad" htmlFor="unit">
          <Input
            id="unit"
            name="unit"
            required
            placeholder="Ej: Caja x 20 tabletas"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Ejemplos: Caja x 20 tabletas, Frasco x 120 ml, Blíster x 10, Unidad.
          </p>
        </Field>
        <div className="sm:col-span-2">
          <LaboratorySearch
            name="laboratoryId"
            label="Laboratorio (opcional)"
            hint="Buscá uno existente o crealo sin salir del formulario."
          />
        </div>
        <Field label="Stock mín." htmlFor="minStock">
          <Input
            id="minStock"
            name="minStock"
            type="number"
            min={0}
            defaultValue={0}
          />
        </Field>
        <Field label="Reorden" htmlFor="reorderQty">
          <Input
            id="reorderQty"
            name="reorderQty"
            type="number"
            min={0}
            defaultValue={0}
          />
        </Field>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.conflictingProductId ? (
        <p className="text-sm">
          <Link
            prefetch={false}
            href={`/productos/${state.conflictingProductId}`}
            className="font-semibold text-primary underline underline-offset-2"
          >
            Ver el producto que ya tiene ese SKU
          </Link>
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          Producto creado.
        </p>
      ) : null}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Guardando…" : "Crear producto"}
      </Button>
    </form>
  );
}
