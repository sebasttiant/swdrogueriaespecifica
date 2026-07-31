"use client";

import { useActionState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
import {
  contactPendingAction,
  invoicePendingAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

type PendingCustomerLifecycleFormProps = {
  pendingId: string;
  customerStatus:
    | "POR_CONTACTAR"
    | "CONTACTADO"
    | "FACTURADO"
    | "ENTREGADO"
    | "CANCELADO"
    | undefined;
  availableQuantity: number;
  invoicedQuantity: number;
};

// --------------------------------------------------------------------------
// El tramo comercial del pendiente, dentro del mismo panel compacto: contactar
// al cliente, y después facturarle lo que ya está en bodega.
//
// Se muestra UNA acción a la vez, la que corresponde al momento. El vendedor no
// elige entre botones: lee el único que hay y lo toca. Facturar antes de
// entregar es una regla del negocio, no una preferencia de la pantalla, así que
// la Server Action la revalida igual aunque acá no se ofrezca el control.
//
// La cantidad a facturar se puede repetir: si llegaron 6 de 10 hoy y 4 mañana,
// el vendedor factura 6 ahora y los 4 restantes cuando entren, sin perder lo ya
// facturado.
// --------------------------------------------------------------------------
export function PendingCustomerLifecycleForm({
  pendingId,
  customerStatus,
  availableQuantity,
  invoicedQuantity,
}: PendingCustomerLifecycleFormProps) {
  const [contactState, contactAction, contacting] = useActionState(
    contactPendingAction,
    INITIAL_STATE,
  );
  const [invoiceState, invoiceAction, invoicing] = useActionState(
    invoicePendingAction,
    INITIAL_STATE,
  );

  if (customerStatus === "POR_CONTACTAR") {
    return (
      <form action={contactAction}>
        <input type="hidden" name="id" value={pendingId} />
        <Button type="submit" disabled={contacting}>
          Contactar cliente
        </Button>
        {contactState.error ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            {contactState.error}
          </p>
        ) : null}
      </form>
    );
  }

  // Solo lo que llegó y todavía no se facturó. Nunca se vuelve a ofrecer lo ya
  // facturado: ese es el error que produce facturas dobles del mismo pedido.
  const additionalAvailable = Math.max(availableQuantity - invoicedQuantity, 0);
  const canInvoice =
    (customerStatus === "CONTACTADO" || customerStatus === "FACTURADO") &&
    additionalAvailable > 0;

  if (!canInvoice) return null;

  return (
    <form action={invoiceAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={pendingId} />
      <Input
        aria-label="Cantidad a facturar"
        name="quantity"
        type="number"
        min={1}
        max={additionalAvailable}
        defaultValue={additionalAvailable}
        className="w-24"
      />
      <Button type="submit" disabled={invoicing}>
        {customerStatus === "FACTURADO"
          ? "Facturar disponible adicional"
          : "Marcar facturado"}
      </Button>
      {invoiceState.error ? (
        <p role="alert" className="basis-full text-xs text-danger">
          {invoiceState.error}
        </p>
      ) : null}
    </form>
  );
}
