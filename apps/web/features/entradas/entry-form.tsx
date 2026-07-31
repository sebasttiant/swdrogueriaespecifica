"use client";

import { useActionState, useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import {
  createInventoryEntryAction,
  type EntryFormState,
} from "@/server/actions/entry.actions";

const INITIAL_STATE: EntryFormState = {
  error: null,
  ok: false,
  closedMissingCount: undefined,
};

export type ProductOption = {
  id: string;
  name: string;
  code: string;
};

type EntryFormProps = {
  products: ProductOption[];
  selectedProductId?: string;
  // Cantidad que la cola de bodega ya sabe que falta cargar. Llega escrita para
  // que recibir una caja no obligue a recordar ni buscar cuánto se había
  // pedido; sigue siendo editable porque el proveedor a veces manda de menos.
  selectedQuantity?: number;
};

// Alta de entrada de inventario. Único client component del slice (necesita
// useActionState). La lista de productos llega del server component que la monta.
export function EntryForm({ products, selectedProductId, selectedQuantity }: EntryFormProps) {
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [state, formAction, isPending] = useActionState(async (previousState: EntryFormState, formData: FormData) => {
    const result = await createInventoryEntryAction(previousState, formData);
    if (result.ok) setOperationId(crypto.randomUUID());
    return result;
  }, INITIAL_STATE);

  if (products.length === 0) {
    return (
      <p className="text-base text-muted-foreground">
        Cargá al menos un producto en el catálogo para registrar entradas.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={operationId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Producto" htmlFor="productId" className="sm:col-span-2">
          <Select id="productId" name="productId" required defaultValue={selectedProductId}>
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
            defaultValue={selectedQuantity ?? 1}
          />
        </Field>
        <Field label="Código de lote" htmlFor="batchCode">
          <Input
            id="batchCode"
            name="batchCode"
            placeholder="Ej: LOTE-2026-001"
            required
            // Cuando se viene desde la cola de bodega, producto y cantidad ya
            // llegan resueltos: el cursor arranca donde sí hay que escribir,
            // que es lo único que se lee de la caja.
            autoFocus={selectedProductId !== undefined}
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
          {state.closedMissingCount && state.closedMissingCount > 0
            ? `Entrada registrada. Se cerraron ${state.closedMissingCount} faltante${state.closedMissingCount === 1 ? "" : "s"} de este producto.`
            : "Entrada registrada correctamente."}
        </p>
      ) : null}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Guardando…" : "Registrar entrada"}
      </Button>
    </form>
  );
}
