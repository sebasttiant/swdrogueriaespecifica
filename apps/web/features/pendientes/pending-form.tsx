"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import {
  createPendingAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

export type ProductOption = {
  id: string;
  name: string;
  code: string;
};

type PendingFormProps = {
  products: ProductOption[];
};

// Alta de pendiente. Único client component del slice (necesita useActionState y
// el toggle catálogo/manual). La lista de productos llega del server component.
export function PendingForm({ products }: PendingFormProps) {
  const [state, formAction, isPending] = useActionState(
    createPendingAction,
    INITIAL_STATE,
  );

  const canSelectExisting = products.length > 0;
  // Modo manual: producto que no está en el catálogo. Si no hay catálogo cargado,
  // el manual es la única vía, así que arranca activo y sin opción de togglear.
  const [manual, setManual] = useState(!canSelectExisting);
  const manualToggleId = useId();

  return (
    <form action={formAction} className="space-y-4">
      {canSelectExisting ? (
        <label
          htmlFor={manualToggleId}
          className="flex items-center gap-2 text-sm font-medium text-text"
        >
          <input
            id={manualToggleId}
            type="checkbox"
            checked={manual}
            onChange={(event) => setManual(event.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
          />
          El producto no está en el catálogo (cargarlo manual)
        </label>
      ) : (
        <p className="text-sm text-muted-foreground">
          No hay productos en el catálogo todavía: cargá el producto manualmente.
          Quedará marcado para que un administrador lo revise.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {manual ? (
          <>
            <Field
              label="Producto (manual)"
              htmlFor="manualName"
              className="sm:col-span-2"
              hint="No está en el catálogo. Se creará marcado para revisión de un administrador."
            >
              <Input
                id="manualName"
                name="manualName"
                required
                maxLength={120}
                placeholder="Nombre del producto"
              />
            </Field>
            <Field
              label="Unidad (opcional)"
              htmlFor="manualUnit"
              className="sm:col-span-2"
            >
              <Input
                id="manualUnit"
                name="manualUnit"
                maxLength={40}
                placeholder="unidad"
              />
            </Field>
          </>
        ) : (
          <Field label="Producto" htmlFor="productId" className="sm:col-span-2">
            <Select id="productId" name="productId" required>
              <option value="">Elegí un producto…</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} ({product.code})
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Cantidad" htmlFor="quantity">
          <Input
            id="quantity"
            name="quantity"
            type="number"
            min={1}
            step={1}
            required
            defaultValue={1}
          />
        </Field>
        <Field label="Entrega prometida" htmlFor="promisedAt">
          <Input
            id="promisedAt"
            name="promisedAt"
            type="datetime-local"
            required
          />
        </Field>
        <Field label="Cliente (opcional)" htmlFor="customerName">
          <Input
            id="customerName"
            name="customerName"
            placeholder="Nombre del cliente"
          />
        </Field>
        <Field label="Nota (opcional)" htmlFor="note" className="sm:col-span-2">
          <Input id="note" name="note" placeholder="Detalle de la solicitud" />
        </Field>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          Pendiente registrado.
        </p>
      ) : null}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Guardando…" : "Registrar pendiente"}
      </Button>
    </form>
  );
}
