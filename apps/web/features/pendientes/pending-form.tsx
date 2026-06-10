"use client";

import { useActionState } from "react";

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

// Alta de pendiente. Único client component del slice (necesita useActionState).
// La lista de productos llega del server component que la monta.
export function PendingForm({ products }: PendingFormProps) {
  const [state, formAction, isPending] = useActionState(
    createPendingAction,
    INITIAL_STATE,
  );

  if (products.length === 0) {
    return (
      <p className="text-base text-muted-foreground">
        Cargá al menos un producto en el catálogo para registrar pendientes.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Producto"
          htmlFor="productId"
          className="sm:col-span-2"
        >
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
        <Field label="Entrega prometida" htmlFor="promisedAt">
          <Input
            id="promisedAt"
            name="promisedAt"
            type="datetime-local"
            required
          />
        </Field>
        <Field
          label="Cliente (opcional)"
          htmlFor="customerName"
        >
          <Input
            id="customerName"
            name="customerName"
            placeholder="Nombre del cliente"
          />
        </Field>
        <Field
          label="Nota (opcional)"
          htmlFor="note"
          className="sm:col-span-2"
        >
          <Input
            id="note"
            name="note"
            placeholder="Detalle de la solicitud"
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
          Pendiente registrado.
        </p>
      ) : null}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Guardando…" : "Registrar pendiente"}
      </Button>
    </form>
  );
}
