"use client";

import { useState } from "react";

import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { LaboratorySearch } from "@/features/productos/laboratory-search";
import { PRESENTATION_LABEL } from "@/features/pendientes/presentation";
import {
  updateProductAction,
  type ProductFormState,
} from "@/server/actions/product.actions";

const INITIAL_STATE: ProductFormState = { error: null, ok: false };

export type EditableProduct = {
  id: string;
  code: string;
  name: string;
  unit: string;
  minStock: number;
  reorderQty: number;
  active: boolean;
  laboratoryId: string | null;
  laboratoryName: string | null;
};

// --------------------------------------------------------------------------
// Edición de los datos de CATÁLOGO de un producto.
//
// Qué se edita acá: identidad y política de reposición. Qué NO, y por qué:
//
//   CANTIDADES. No hay un campo de stock y no lo va a haber. El stock se mueve
//   con entradas, salidas y ajustes, que dejan un movimiento auditable detrás.
//   Un "stock = 20" escrito a mano vuelve ficción cualquier cuadre posterior,
//   porque nadie puede reconstruir de dónde salió ese número. La Server Action
//   ni siquiera acepta el campo: no es una validación, es que no compila.
//
//   EL SKU. Vive en la tarjeta de identidad de esta misma pantalla, que tiene
//   control de concurrencia: vincularlo cuando falta y corregirlo
//   explícitamente cuando ya existe son dos actos distintos. Meterlo como un
//   campo más de este formulario convertiría "moví una identidad que todo el
//   inventario referencia" en un efecto colateral de guardar el nombre.
//
// Arranca plegado: la pantalla de producto se abre para MIRAR —stock, lotes,
// identidad— y un formulario largo desplegado empuja todo eso hacia abajo.
// --------------------------------------------------------------------------
export function ProductEditForm({ product }: { product: EditableProduct }) {
  const [state, formAction, isPending] = useActionState(
    updateProductAction,
    INITIAL_STATE,
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Datos del producto</CardTitle>
          <p className="text-sm text-muted-foreground">
            Nombre, código, presentación, mínimos y laboratorio.
          </p>
        </div>
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Editar producto
        </Button>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <CardTitle>Editar producto</CardTitle>

      <form action={formAction} className="space-y-4">
        <input type="hidden" name="id" value={product.id} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" htmlFor="edit-name" className="sm:col-span-2">
            <Input
              id="edit-name"
              name="name"
              required
              maxLength={120}
              defaultValue={product.name}
            />
          </Field>

          {/* El código INTERNO del catálogo (`PROV-…`, `MED-001`), no el SKU:
              no existe del otro lado, en Orión. La ambigüedad entre los dos ya
              hizo elegir el producto equivocado al registrar una entrada. */}
          <Field
            label="Código interno"
            htmlFor="edit-code"
            hint="El del catálogo, no el de Orión."
          >
            <Input
              id="edit-code"
              name="code"
              required
              maxLength={40}
              defaultValue={product.code}
            />
          </Field>

          <Field
            label={PRESENTATION_LABEL}
            htmlFor="edit-unit"
            hint="Cómo viene: Frasco, Sobre, Caja, Blíster, Ampolla."
          >
            <Input
              id="edit-unit"
              name="unit"
              required
              maxLength={20}
              defaultValue={product.unit}
            />
          </Field>

          <Field
            label="Stock mínimo"
            htmlFor="edit-minStock"
            hint="Debajo de esto, el producto avisa."
          >
            <Input
              id="edit-minStock"
              name="minStock"
              type="number"
              min={0}
              defaultValue={product.minStock}
            />
          </Field>

          <Field
            label="Cantidad de reorden"
            htmlFor="edit-reorderQty"
            hint="Cuánto conviene pedir cuando toca reponer."
          >
            <Input
              id="edit-reorderQty"
              name="reorderQty"
              type="number"
              min={0}
              defaultValue={product.reorderQty}
            />
          </Field>

          {/* El buscador con creación inline, no un selector: reusa la
              identidad canónica de la base, así "Bayer", "bayer" y "  Bayer  "
              resuelven al mismo laboratorio en vez de crear tres. */}
          <div className="sm:col-span-2">
            <LaboratorySearch
              name="laboratoryId"
              nameForLabel="laboratoryName"
              label="Laboratorio del catálogo"
              hint="Buscá uno existente o creá uno nuevo. Vacío = sin laboratorio."
              defaultSelectedId={product.laboratoryId ?? undefined}
              defaultSelectedName={product.laboratoryName ?? undefined}
            />
          </div>

          {/* Desactivar NO borra: el producto sale de las listas de captura y
              conserva su historia, sus lotes y sus movimientos. Borrarlo
              rompería todo lo que lo referencia. */}
          <label
            htmlFor="edit-active"
            className="flex items-center gap-2 text-sm font-medium text-text sm:col-span-2"
          >
            <input
              id="edit-active"
              type="checkbox"
              name="active"
              defaultChecked={product.active}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            Producto activo
          </label>
        </div>

        {/* Lo que este formulario NO hace, dicho en la pantalla: si no se
            explica, alguien va a buscar el stock acá y no lo va a encontrar. */}
        <p className="text-xs text-muted-foreground">
          El stock no se edita acá: cambia con entradas, salidas y ajustes, que
          dejan un movimiento auditable. El SKU se corrige desde la tarjeta de
          identidad.
        </p>

        {state.error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p role="status" className="text-sm font-medium text-success">
            Producto actualizado.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? "Guardando…" : "Guardar cambios"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
        </div>
      </form>
    </Card>
  );
}
