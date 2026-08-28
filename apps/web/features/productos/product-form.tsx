"use client";

import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import {
  createProductAction,
  type ProductFormState,
} from "@/server/actions/product.actions";

const INITIAL_STATE: ProductFormState = { error: null, ok: false };

type Laboratory = { id: string; name: string };

// Alta de producto. Solo se monta para SUPERADMIN/ADMIN (la página decide).
export function ProductForm({ laboratories = [] }: { laboratories?: Laboratory[] }) {
  const [state, formAction, isPending] = useActionState(
    createProductAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Código" htmlFor="code">
          <Input id="code" name="code" required />
        </Field>
        <Field label="Nombre" htmlFor="name">
          <Input id="name" name="name" required />
        </Field>
        <Field label="Unidad" htmlFor="unit">
          <Input
            id="unit"
            name="unit"
            required
            placeholder="caja, unidad, ml…"
          />
        </Field>
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
        {laboratories.length > 0 ? (
          <Field label="Laboratorio" htmlFor="laboratoryId">
            <Select id="laboratoryId" name="laboratoryId" defaultValue="">
              <option value="">Sin laboratorio</option>
              {laboratories.map((lab) => (
                <option key={lab.id} value={lab.id}>
                  {lab.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
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
