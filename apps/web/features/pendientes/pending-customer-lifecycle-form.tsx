"use client";

import { useActionState } from "@/lib/hooks/use-action-state";
import { FileText } from "lucide-react";

import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
import {
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
  /** Lo que el cliente pidió. Es el techo de lo que se puede facturar. */
  quantity: number;
  invoicedQuantity: number;
};

// --------------------------------------------------------------------------
// "Facturar" — el paso del vendedor sobre su propio pendiente.
//
// Una sola acción, sin pasos previos. Antes había que registrar un contacto y
// esperar a que el sistema viera stock, y hasta entonces el vendedor no tenía
// NINGÚN control sobre su pedido. En la droguería el orden real es al revés:
// la persona factura y el sistema lo registra.
//
// La cantidad viene precargada con lo que falta por facturar, porque el caso
// normal es facturar todo de una. Se puede bajar cuando el cliente se lleva
// una parte.
// --------------------------------------------------------------------------
export function PendingCustomerLifecycleForm({
  pendingId,
  customerStatus,
  quantity,
  invoicedQuantity,
}: PendingCustomerLifecycleFormProps) {
  const [state, invoiceAction, invoicing] = useActionState(
    invoicePendingAction,
    INITIAL_STATE,
  );

  const remainingToInvoice = Math.max(quantity - invoicedQuantity, 0);
  if (customerStatus === "ENTREGADO" || customerStatus === "CANCELADO") return null;
  if (remainingToInvoice === 0) return null;

  const isPartial = invoicedQuantity > 0;

  return (
    <form action={invoiceAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={pendingId} />
      {/* Facturar todo es el caso normal; el número solo se toca en la
          excepción, así que no roba el foco de la acción. */}
      <Input
        aria-label="Cantidad a facturar"
        name="quantity"
        type="number"
        min={1}
        max={remainingToInvoice}
        defaultValue={remainingToInvoice}
        className="w-20"
      />
      <Button type="submit" disabled={invoicing}>
        <FileText className="size-4" aria-hidden />
        {isPartial ? "Facturar el resto" : "Facturar"}
      </Button>
      {state.error ? (
        <p role="alert" className="basis-full text-xs text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
