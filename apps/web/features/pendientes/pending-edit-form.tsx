"use client";

import { useState } from "react";
import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import {
  PAYMENT_METHODS,
  paymentMethodLabel,
  type PaymentMethod,
} from "@/features/pendientes/payment-method";
import { parseCopInput } from "@/lib/format/currency";
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
  note: string | null;
  zone: string | null;
  // Identidad, montos y vendedor escrito: AUSENTES en una corrección
  // restringida (fila ajena). El servidor no los manda para ese formulario.
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  manualSellerName?: string | null;
  totalAmount?: number | null;
  paidAmount?: number;
  paymentMethod?: PaymentMethod | null;
  /** Testigo de concurrencia: viaja oculto y el servidor lo compara bajo el lock. */
  updatedAt: Date;
};

type PendingEditFormProps = {
  pending: PendingEditValues;
  products: ProductOption[];
  zones?: string[];
  /** Mínimo permitido: lo ya facturado o entregado no se puede desdecir. */
  minQuantity: number;
  /** Aviso para el vendedor: esta es su única corrección. */
  isLastChance: boolean;
  /**
   * Corrección de una fila AJENA por quien no opera la cola entera: no se
   * renderizan identidad del cliente, montos ni vendedor escrito. No es un
   * ocultamiento visual: sin el input el campo no viaja, y si viajara el
   * servidor rechazaría la solicitud.
   */
  restricted?: boolean;
  /** Producto fijo: la fila ajena ya tiene unidades facturadas o entregadas. */
  productLocked?: boolean;
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
// Gerencia lo hace sobre cualquiera, con todos los campos. Quien tiene
// `canEditAllPendings` también corrige cualquiera, pero sobre una fila AJENA
// solo los datos operativos (`restricted`). Quien no tiene ninguna de las dos
// autoridades corrige el suyo UNA vez, y por eso se le avisa antes de guardar.
//
// El formulario llega con todo cargado. Corregir es cambiar un dato, no volver
// a escribir el pedido entero. Lleva el `updatedAt` de la carga: si alguien
// guardó en el medio, el servidor rechaza en vez de pisar su cambio.
// --------------------------------------------------------------------------
export function PendingEditForm({
  pending,
  products,
  zones = [],
  minQuantity,
  isLastChance,
  restricted = false,
  productLocked = false,
}: PendingEditFormProps) {
  const [state, action, saving] = useActionState(updatePendingAction, INITIAL_STATE);
  // Abono y medio CONTROLADOS: el medio se muestra solo cuando hay plata, así
  // que el formulario tiene que saber qué dice el campo mientras se escribe.
  // El resto de los campos siguen sin estado, que es como estaban.
  const [paidAmount, setPaidAmount] = useState(
    pending.paidAmount ? String(pending.paidAmount) : "",
  );
  const [paymentMethod, setPaymentMethod] = useState<string>(
    pending.paymentMethod ?? "",
  );
  const parsedPaid = parseCopInput(paidAmount);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={pending.id} />
      <input
        type="hidden"
        id="expectedUpdatedAt"
        name="expectedUpdatedAt"
        value={pending.updatedAt.toISOString()}
      />

      {isLastChance ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
        >
          Es tu única corrección de este pendiente. Después solo lo puede cambiar
          gerencia.
        </p>
      ) : null}

      {restricted ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Este pendiente lo registró otra persona. Podés corregir producto,
          cantidad, fecha, zona y nota; los datos del cliente y los montos no se
          cambian desde acá.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Producto" htmlFor="productId" className="sm:col-span-2">
          {/* Un <select> deshabilitado no se envía: el producto fijo viaja en
              un campo oculto para que la corrección conserve el que ya tiene. */}
          <Select
            id="productId"
            name={productLocked ? undefined : "productId"}
            required
            disabled={productLocked}
            defaultValue={pending.productId}
          >
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {optionLabel(product)}
              </option>
            ))}
          </Select>
          {productLocked ? (
            <>
              <input type="hidden" name="productId" value={pending.productId} />
              <p className="mt-1 text-xs text-muted-foreground">
                El producto no se puede cambiar: este pendiente ya tiene unidades
                facturadas o entregadas.
              </p>
            </>
          ) : null}
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

        {restricted ? null : (
          <>
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
          </>
        )}

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

        {restricted ? null : (
          <>
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
                value={paidAmount}
                onChange={(event) => setPaidAmount(event.target.value)}
              />
            </Field>

            {/* Misma regla que en el alta, y escrita igual a propósito: el medio
                solo existe si hay abono. Acá pesa más todavía, porque corregir el
                abono a cero tiene que PODER limpiar el medio: desmontarlo deja de
                mandarlo, el validador lo exige ausente y el UPDATE lo escribe en
                null. Un pendiente viejo con abono y sin medio pide elegirlo recién
                cuando alguien lo edita, que es cuando hay una persona mirando. */}
            {parsedPaid !== null && parsedPaid > 0 ? (
              <Field label="¿Cómo pagó?" htmlFor="paymentMethod">
                <Select
                  id="paymentMethod"
                  name="paymentMethod"
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                  required
                >
                  <option value="" disabled>
                    Elegí el medio…
                  </option>
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {paymentMethodLabel(method)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            {/* Precargado: guardar sin tocarlo conserva el vendedor escrito, y
                vaciarlo lo borra. Mismo permiso que el resto de la corrección: por
                eso tampoco entra en la corrección de una fila ajena. */}
            <Field label="Vendedor (opcional)" htmlFor="manualSellerName" className="sm:col-span-2">
              <Input
                id="manualSellerName"
                name="manualSellerName"
                maxLength={120}
                autoComplete="off"
                defaultValue={pending.manualSellerName ?? ""}
              />
            </Field>
          </>
        )}

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
          {state.unchanged ? "No había cambios para guardar." : "Pendiente corregido."}
        </p>
      ) : null}

      <Button type="submit" disabled={saving}>
        Guardar corrección
      </Button>
    </form>
  );
}
