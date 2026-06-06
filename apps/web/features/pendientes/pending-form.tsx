"use client";

import { useActionState } from "react";

import { Button } from "@/app/_components/ui/button";
import {
  createPendingAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

const fieldClass =
  "min-h-11 w-full rounded-[var(--radius-btn)] border border-border bg-muted/40 px-3 text-base text-text placeholder:text-muted-foreground";

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
        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="productId" className="text-sm font-medium text-text">
            Producto
          </label>
          <select id="productId" name="productId" required className={fieldClass}>
            <option value="">Elegí un producto…</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name} ({product.code})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="quantity" className="text-sm font-medium text-text">
            Cantidad
          </label>
          <input
            id="quantity"
            name="quantity"
            type="number"
            min={1}
            step={1}
            required
            defaultValue={1}
            className={fieldClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="customerName" className="text-sm font-medium text-text">
            Cliente <span className="text-muted-foreground">(opcional)</span>
          </label>
          <input
            id="customerName"
            name="customerName"
            placeholder="Nombre del cliente"
            className={fieldClass}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="note" className="text-sm font-medium text-text">
            Nota <span className="text-muted-foreground">(opcional)</span>
          </label>
          <input
            id="note"
            name="note"
            placeholder="Detalle de la solicitud"
            className={fieldClass}
          />
        </div>
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
