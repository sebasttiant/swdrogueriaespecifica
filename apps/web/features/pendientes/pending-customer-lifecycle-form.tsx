"use client";

import { useState, type FormEvent } from "react";
import { useActionState } from "@/lib/hooks/use-action-state";
import { FileText } from "lucide-react";

import { Alert } from "@/app/_components/ui/alert";
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
  /**
   * Lo facturado hasta ahora. Viaja también como token de concurrencia: el
   * servidor rechaza el intento si, bajo el lock, ya no es lo que se vio.
   */
  invoicedQuantity: number;
  /** Lo que tiene stock para facturar (`invoiceableQuantity`, U4). */
  invoiceableQuantity: number;
};

// --------------------------------------------------------------------------
// "Facturar" — el paso del vendedor sobre su propio pendiente.
//
// Una sola acción, sin pasos previos. Antes había que registrar un contacto y
// esperar a que el sistema viera stock, y hasta entonces el vendedor no tenía
// NINGÚN control sobre su pedido. En la droguería el orden real es al revés:
// la persona factura y el sistema lo registra.
//
// La cantidad viene precargada con lo que tiene stock, porque el caso normal es
// facturar eso de un toque. Se puede bajar cuando el cliente se lleva una parte.
//
// U5 — la excepción sin stock. Si la cantidad supera lo que tiene stock, el
// formulario NO envía: pide una segunda confirmación (mismo patrón que
// `UserArchiveButton`) que dice cuánto tiene stock y cuánto se facturaría sin
// él. Solo esa confirmación manda `allowWithoutStock`. El servidor sigue
// decidiendo todo bajo el lock, y si igual rechaza, se muestra su mensaje.
// --------------------------------------------------------------------------
export function PendingCustomerLifecycleForm({
  pendingId,
  customerStatus,
  quantity,
  invoicedQuantity,
  invoiceableQuantity,
}: PendingCustomerLifecycleFormProps) {
  const [state, invoiceAction, invoicing] = useActionState(
    invoicePendingAction,
    INITIAL_STATE,
  );
  // La cantidad que espera confirmación sin stock; null fuera de ese paso.
  const [withoutStockQuantity, setWithoutStockQuantity] = useState<number | null>(null);

  const remainingToInvoice = Math.max(quantity - invoicedQuantity, 0);
  if (customerStatus === "ENTREGADO" || customerStatus === "CANCELADO") return null;
  if (remainingToInvoice === 0) return null;

  const isPartial = invoicedQuantity > 0;

  const errorMessage = state.error ? (
    <p role="alert" className="basis-full text-xs text-danger">
      {state.error}
    </p>
  ) : null;

  // Por encima de lo que tiene stock no se envía todavía: se pregunta. Una
  // cantidad por encima del saldo sí se envía, y la rechaza el servidor.
  function askBeforeInvoicingWithoutStock(event: FormEvent<HTMLFormElement>) {
    const entered = Number(new FormData(event.currentTarget).get("quantity"));
    if (
      Number.isInteger(entered) &&
      entered > invoiceableQuantity &&
      entered <= remainingToInvoice
    ) {
      event.preventDefault();
      setWithoutStockQuantity(entered);
    }
  }

  // Se cierra el paso al enviar: el botón de confirmar desaparece, así que un
  // segundo clic no existe, y la respuesta (o su error) se lee en el formulario.
  function confirmWithoutStock(formData: FormData) {
    setWithoutStockQuantity(null);
    invoiceAction(formData);
  }

  if (withoutStockQuantity !== null) {
    return (
      <div className="flex flex-col gap-2">
        <Alert tone="warning" role="status" className="max-w-xs text-xs">
          {invoiceableQuantity > 0
            ? `Hay stock para ${invoiceableQuantity}.`
            : "No hay stock cargado."}{" "}
          Se van a facturar{" "}
          <span className="font-semibold">
            {withoutStockQuantity - invoiceableQuantity} sin stock
          </span>
          . Esto no crea stock ni habilita la entrega.
        </Alert>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="md"
            variant="outline"
            disabled={invoicing}
            onClick={() => setWithoutStockQuantity(null)}
          >
            Cancelar
          </Button>
          <form action={confirmWithoutStock}>
            <input type="hidden" name="id" value={pendingId} />
            <input type="hidden" name="quantity" value={withoutStockQuantity} />
            <input type="hidden" name="expectedInvoicedQuantity" value={invoicedQuantity} />
            <input type="hidden" name="allowWithoutStock" value="1" />
            <Button type="submit" size="md" disabled={invoicing}>
              Confirmar facturación sin stock
            </Button>
          </form>
        </div>
        {errorMessage}
      </div>
    );
  }

  return (
    <form
      action={invoiceAction}
      onSubmit={askBeforeInvoicingWithoutStock}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="id" value={pendingId} />
      <input type="hidden" name="expectedInvoicedQuantity" value={invoicedQuantity} />
      {/* Facturar lo que tiene stock es el caso normal; el número solo se toca
          en la excepción, así que no roba el foco de la acción. */}
      <Input
        aria-label="Cantidad a facturar"
        name="quantity"
        type="number"
        min={1}
        max={remainingToInvoice}
        defaultValue={invoiceableQuantity > 0 ? invoiceableQuantity : remainingToInvoice}
        className="w-20"
      />
      <Button type="submit" disabled={invoicing}>
        <FileText className="size-4" aria-hidden />
        {isPartial ? "Facturar el resto" : "Facturar"}
      </Button>
      {errorMessage}
    </form>
  );
}
