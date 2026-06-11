"use client";

import { useActionState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import {
  createInventoryEntryAction,
  type EntryFormState,
} from "@/server/actions/entry.actions";

const INITIAL_STATE: EntryFormState = { error: null, ok: false };

export type ProductOption = {
  id: string;
  name: string;
  code: string;
};

type EntryFormProps = {
  products: ProductOption[];
};

// Alta de entrada de inventario. Único client component del slice (necesita
// useActionState). La lista de productos llega del server component que la monta.
export function EntryForm({ products }: EntryFormProps) {
  const [state, formAction, isPending] = useActionState(
    createInventoryEntryAction,
    INITIAL_STATE,
  );

  if (products.length === 0) {
    return (
      <p className="text-base text-muted-foreground">
        Cargá al menos un producto en el catálogo para registrar entradas.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
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
        <Field label="Código de lote" htmlFor="batchCode">
          <Input
            id="batchCode"
            name="batchCode"
            placeholder="Ej: LOTE-2026-001"
            required
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Si el lote ya existe para este producto, se suma la cantidad.
          </p>
        </Field>
        <Field label="Fecha de vencimiento" htmlFor="expiresAt">
          <Input
            id="expiresAt"
            name="expiresAt"
            type="datetime-local"
            required
          />
        </Field>
        <Field label="Nota (opcional)" htmlFor="note" className="sm:col-span-2">
          <Input
            id="note"
            name="note"
            placeholder="Observaciones de la recepción"
          />
        </Field>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          Entrada registrada correctamente.
        </p>
      ) : null}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Guardando…" : "Registrar entrada"}
      </Button>
    </form>
  );
}
