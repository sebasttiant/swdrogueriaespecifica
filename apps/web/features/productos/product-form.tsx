"use client";

import { useActionState } from "react";

import { Button } from "@/app/_components/ui/button";
import {
  createProductAction,
  type ProductFormState,
} from "@/server/actions/product.actions";

const INITIAL_STATE: ProductFormState = { error: null, ok: false };

const inputClass =
  "min-h-11 w-full rounded-[var(--radius-btn)] border border-border bg-muted/40 px-3 text-base text-text placeholder:text-muted-foreground";

// Alta de producto. Solo se monta para ADMIN/LIDER (la página decide).
export function ProductForm() {
  const [state, formAction, isPending] = useActionState(
    createProductAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="code" className="text-sm font-medium text-text">
            Código
          </label>
          <input id="code" name="code" required className={inputClass} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="name" className="text-sm font-medium text-text">
            Nombre
          </label>
          <input id="name" name="name" required className={inputClass} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="unit" className="text-sm font-medium text-text">
            Unidad
          </label>
          <input
            id="unit"
            name="unit"
            required
            placeholder="caja, unidad, ml…"
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="minStock" className="text-sm font-medium text-text">
              Stock mín.
            </label>
            <input
              id="minStock"
              name="minStock"
              type="number"
              min={0}
              defaultValue={0}
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="reorderQty" className="text-sm font-medium text-text">
              Reorden
            </label>
            <input
              id="reorderQty"
              name="reorderQty"
              type="number"
              min={0}
              defaultValue={0}
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
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
