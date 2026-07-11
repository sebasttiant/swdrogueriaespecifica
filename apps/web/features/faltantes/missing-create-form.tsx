"use client";

import { Plus } from "lucide-react";
import { useActionState, useId, useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import {
  createMissingItemAction,
  type MissingItemActionState,
} from "@/server/actions/missing-item.actions";

const INITIAL_STATE: MissingItemActionState = { error: null, ok: false };

export type MissingCreateProductOption = {
  id: string;
  name: string;
  code: string;
};

type MissingCreateFormProps = {
  products: MissingCreateProductOption[];
  defaultOpen?: boolean;
};

export function MissingCreateForm({
  products,
  defaultOpen = false,
}: MissingCreateFormProps) {
  const [state, formAction, isPending] = useActionState(
    createMissingItemAction,
    INITIAL_STATE,
  );
  const [open, setOpen] = useState(defaultOpen);
  const productId = useId();
  const quantityId = useId();
  const noteId = useId();

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        Nuevo faltante
      </Button>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
      <Field label="Producto" htmlFor={productId}>
        <Select id={productId} name="productId" required defaultValue="">
          <option value="" disabled>
            Elegí un producto…
          </option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name} ({product.code})
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Cantidad" htmlFor={quantityId}>
        <Input
          id={quantityId}
          name="quantity"
          type="number"
          min={1}
          step={1}
          required
          defaultValue={1}
        />
      </Field>

      <Field label="Nota (opcional)" htmlFor={noteId}>
        <Input id={noteId} name="note" maxLength={300} placeholder="Detalle operativo" />
      </Field>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          Faltante registrado.
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} className="flex-1">
          Cancelar
        </Button>
        <Button type="submit" disabled={isPending} className="flex-1">
          <Plus aria-hidden="true" className="h-4 w-4" />
          {isPending ? "Guardando…" : "Crear faltante"}
        </Button>
      </div>
    </form>
  );
}
