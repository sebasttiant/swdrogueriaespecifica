"use client";

import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { MAX_ZONE_LENGTH } from "@/features/pendientes/zone";
import { MAX_PHONE_INPUT_LENGTH } from "@/features/pendientes/phone";
import {
  updatePendingAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";

import { optionLabel, type ProductOption } from "./pending-form";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

export type PendingEditValues = {
  id: string;
  productId: string;
  quantity: number;
  promisedAt: Date;
  customerName: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  note: string | null;
  zone: string | null;
  totalAmount: number | null;
  paidAmount: number;
};

type PendingEditFormProps = {
  pending: PendingEditValues;
  products: ProductOption[];
  zones?: string[];
  /** Mínimo permitido: lo ya facturado o entregado no se puede desdecir. */
  minQuantity: number;
  /** Aviso para el vendedor: esta es su única corrección. */
  isLastChance: boolean;
};

// Valor para <input type="datetime-local">: hora de pared de Bogotá, sin zona.
// Se arma con las partes locales del navegador porque el formulario ya trabaja
// en esa misma convención (ver `parseBogotaWallTime` del lado del servidor).
function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

// --------------------------------------------------------------------------
// Corregir un pendiente.
//
// Gerencia lo hace sobre cualquiera y las veces que haga falta. El vendedor
// solo sobre el suyo y UNA vez, y por eso se le avisa antes de guardar: no es
// lo mismo corregir un dígito del teléfono sabiendo que es tu único intento.
//
// El formulario llega con todo cargado. Corregir es cambiar un dato, no volver
// a escribir el pedido entero.
// --------------------------------------------------------------------------
export function PendingEditForm({
  pending,
  products,
  zones = [],
  minQuantity,
  isLastChance,
}: PendingEditFormProps) {
  const [state, action, saving] = useActionState(updatePendingAction, INITIAL_STATE);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={pending.id} />

      {isLastChance ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
        >
          Es tu única corrección de este pendiente. Después solo lo puede cambiar
          gerencia.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Producto" htmlFor="productId" className="sm:col-span-2">
          <Select id="productId" name="productId" required defaultValue={pending.productId}>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {optionLabel(product)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Cantidad" htmlFor="quantity">
          <Input
            id="quantity"
            name="quantity"
            type="number"
            min={Math.max(minQuantity, 1)}
            step={1}
            required
            defaultValue={pending.quantity}
          />
          {minQuantity > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No puede ser menor a {minQuantity}: es lo ya facturado o entregado.
            </p>
          ) : null}
        </Field>

        <Field label="Para cuándo" htmlFor="promisedAt">
          <Input
            id="promisedAt"
            name="promisedAt"
            type="datetime-local"
            required
            defaultValue={toLocalInputValue(pending.promisedAt)}
          />
        </Field>

        <Field label="Cliente" htmlFor="customerName">
          <Input
            id="customerName"
            name="customerName"
            required
            maxLength={120}
            defaultValue={pending.customerName ?? ""}
          />
        </Field>

        <Field label="Teléfono" htmlFor="customerPhone">
          <Input
            id="customerPhone"
            name="customerPhone"
            required
            inputMode="tel"
            maxLength={MAX_PHONE_INPUT_LENGTH}
            defaultValue={pending.customerPhone ?? ""}
          />
        </Field>

        <Field label="Dirección (opcional)" htmlFor="customerAddress">
          <Input
            id="customerAddress"
            name="customerAddress"
            maxLength={200}
            defaultValue={pending.customerAddress ?? ""}
          />
        </Field>

        <Field label="Zona (opcional)" htmlFor="zone">
          <Input
            id="zone"
            name="zone"
            list="pending-edit-zones"
            maxLength={MAX_ZONE_LENGTH}
            defaultValue={pending.zone ?? ""}
          />
          <datalist id="pending-edit-zones">
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </Field>

        <Field label="Valor total (opcional)" htmlFor="totalAmount">
          <Input
            id="totalAmount"
            name="totalAmount"
            inputMode="numeric"
            defaultValue={pending.totalAmount ?? ""}
          />
        </Field>

        <Field label="Abonó (opcional)" htmlFor="paidAmount">
          <Input
            id="paidAmount"
            name="paidAmount"
            inputMode="numeric"
            defaultValue={pending.paidAmount || ""}
          />
        </Field>

        <Field label="Nota (opcional)" htmlFor="note" className="sm:col-span-2">
          <Input
            id="note"
            name="note"
            maxLength={280}
            defaultValue={pending.note ?? ""}
          />
        </Field>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm text-success">
          Pendiente corregido.
        </p>
      ) : null}

      <Button type="submit" disabled={saving}>
        Guardar corrección
      </Button>
    </form>
  );
}
