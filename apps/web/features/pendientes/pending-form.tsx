"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import {
  buildPromisedAtOptions,
  defaultPromisedAtValue,
} from "@/features/pendientes/promised-at-options";
import {
  derivePaymentState,
  remainingAmount,
} from "@/features/pendientes/payment-state";
import { MAX_ZONE_LENGTH } from "@/features/pendientes/zone";
import { MAX_PHONE_INPUT_LENGTH } from "@/features/pendientes/phone";
import { formatCop, parseCopInput } from "@/lib/format/currency";
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
  // Zonas ya usadas, para sugerir en vez de obligar a recordar cómo se escribió.
  // Sugerencia, no restricción: una zona nueva se escribe igual de rápido.
  zones?: string[];
  // Inyectables para tests deterministas; en producción usan los defaults.
  now?: Date;
  defaultCustom?: boolean;
};

// Alta de pendiente. Único client component del slice (necesita useActionState y
// el toggle catálogo/manual). La lista de productos llega del server component.
export function PendingForm({
  products,
  zones = [],
  now = new Date(),
  defaultCustom = false,
}: PendingFormProps) {
  const [state, formAction, isPending] = useActionState(
    createPendingAction,
    INITIAL_STATE,
  );

  const canSelectExisting = products.length > 0;
  // Modo manual: producto que no está en el catálogo. Si no hay catálogo cargado,
  // el manual es la única vía, así que arranca activo y sin opción de togglear.
  const [manual, setManual] = useState(!canSelectExisting);
  const manualToggleId = useId();

  // Entrega prometida: atajos rápidos (el caso común) + un modo personalizado
  // que muestra el `datetime-local` de siempre (el caso raro). El valor viaja
  // como `promisedAt` sin cambiar el contrato del backend.
  const promisedAtOptions = buildPromisedAtOptions(now);
  const [promisedAt, setPromisedAt] = useState(() => defaultPromisedAtValue(now));
  const [customPromisedAt, setCustomPromisedAt] = useState(defaultCustom);
  const promisedAtCustomId = useId();

  // Montos como TEXTO, no como number: el operador escribe "45.000" con el punto
  // de miles y un <input type="number"> lo rechazaría. El texto se interpreta
  // con `parseCopInput`, el mismo lector que usa el servidor.
  const [totalAmount, setTotalAmount] = useState("");
  const [paidAmount, setPaidAmount] = useState("");
  const zonesListId = useId();

  const parsedTotal = parseCopInput(totalAmount);
  const parsedPaid = parseCopInput(paidAmount);
  const payment = { totalAmount: parsedTotal, paidAmount: parsedPaid ?? 0 };
  const paymentState = derivePaymentState(payment);
  const balance = remainingAmount(payment);
  // El abono sobre un total conocido nunca debería superarlo; se avisa mientras
  // se escribe en vez de esperar al rechazo del servidor.
  const overpaid = parsedTotal !== null && parsedPaid !== null && parsedPaid > parsedTotal;

  return (
    <form action={formAction} className="space-y-4">
      {canSelectExisting ? (
        <label
          htmlFor={manualToggleId}
          className="flex items-center gap-2 text-sm font-medium text-text"
        >
          <input
            id={manualToggleId}
            type="checkbox"
            checked={manual}
            onChange={(event) => setManual(event.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
          />
          El producto no está en el catálogo (cargarlo manual)
        </label>
      ) : (
        <p className="text-sm text-muted-foreground">
          No hay productos en el catálogo todavía: cargá el producto manualmente.
          Quedará marcado para que un administrador lo revise.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {manual ? (
          <>
            <Field
              label="Producto (manual)"
              htmlFor="manualName"
              className="sm:col-span-2"
              hint="No está en el catálogo. Se creará marcado para revisión de un administrador."
            >
              <Input
                id="manualName"
                name="manualName"
                required
                maxLength={120}
                placeholder="Nombre del producto"
              />
            </Field>
            <Field
              label="Unidad (opcional)"
              htmlFor="manualUnit"
              className="sm:col-span-2"
            >
              <Input
                id="manualUnit"
                name="manualUnit"
                maxLength={40}
                placeholder="unidad"
              />
            </Field>
          </>
        ) : (
          <Field label="Producto" htmlFor="productId" className="sm:col-span-2">
            <Select id="productId" name="productId" required>
              <option value="">Elegí un producto…</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} ({product.code})
                </option>
              ))}
            </Select>
          </Field>
        )}

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
        <div className="space-y-1.5 sm:col-span-2">
          <span className="text-sm font-medium text-text">Entrega prometida</span>
          {/* El campo real que viaja al backend: siempre lleva un valor (arranca
              con el default), así que nunca se envía vacío. */}
          <input type="hidden" name="promisedAt" value={promisedAt} />
          {/* `flex-wrap`: en pantalla ancha los atajos van en línea; en el
              celular envuelven. Targets `min-h-11` para el pulgar. */}
          <div className="flex flex-wrap gap-2">
            {promisedAtOptions.map((option) => (
              <Button
                key={option.key}
                type="button"
                variant={
                  !customPromisedAt && promisedAt === option.value
                    ? "secondary"
                    : "ghost"
                }
                disabled={option.disabled}
                onClick={() => {
                  setPromisedAt(option.value);
                  setCustomPromisedAt(false);
                }}
                className="min-h-11"
              >
                {option.label}
              </Button>
            ))}
            <Button
              type="button"
              variant={customPromisedAt ? "secondary" : "ghost"}
              onClick={() => setCustomPromisedAt(true)}
              className="min-h-11"
            >
              Personalizado
            </Button>
          </div>
          {customPromisedAt ? (
            <Input
              id={promisedAtCustomId}
              type="datetime-local"
              required
              value={promisedAt}
              onChange={(event) => setPromisedAt(event.target.value)}
              aria-label="Fecha y hora personalizada"
            />
          ) : null}
        </div>
        <Field
          label="Zona o barrio"
          htmlFor="zone"
          hint="Se guarda con formato uniforme para poder agrupar por zona."
        >
          {/* `list` sugiere las zonas ya usadas sin impedir escribir una nueva:
              un <select> obligaría a mantener un catálogo de zonas antes de
              poder cargar el primer pendiente de una zona nueva. */}
          <Input
            id="zone"
            name="zone"
            list={zones.length > 0 ? zonesListId : undefined}
            maxLength={MAX_ZONE_LENGTH}
            placeholder="Norte, Centro, Chapinero…"
          />
          {zones.length > 0 ? (
            <datalist id={zonesListId}>
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          ) : null}
        </Field>

        {/* Nombre y teléfono son obligatorios: un pendiente es un compromiso
            con una persona concreta, y sin teléfono no se le puede avisar que
            llegó. `required` es ayuda del navegador; el servidor revalida. */}
        <Field label="Cliente" htmlFor="customerName">
          <Input
            id="customerName"
            name="customerName"
            required
            maxLength={120}
            placeholder="Nombre del cliente"
          />
        </Field>
        <Field label="Teléfono" htmlFor="customerPhone">
          <Input
            id="customerPhone"
            name="customerPhone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            maxLength={MAX_PHONE_INPUT_LENGTH}
            placeholder="300 123 4567"
          />
        </Field>
        {/* Pago: dos montos y NADA más. El "pagado totalmente" no es un campo,
            es el resultado de que el abono cubra el total — se muestra abajo. */}
        <div className="space-y-3 sm:col-span-2">
          <span className="text-sm font-medium text-text">Pago (opcional)</span>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Valor total" htmlFor="totalAmount">
              <Input
                id="totalAmount"
                name="totalAmount"
                // Texto + teclado numérico: `type="number"` rechaza el punto de
                // miles que la gente escribe de verdad ("45.000").
                inputMode="numeric"
                autoComplete="off"
                placeholder="$ 45.000"
                value={totalAmount}
                onChange={(event) => setTotalAmount(event.target.value)}
              />
            </Field>
            <Field label="Abono" htmlFor="paidAmount">
              <Input
                id="paidAmount"
                name="paidAmount"
                inputMode="numeric"
                autoComplete="off"
                placeholder="$ 20.000"
                value={paidAmount}
                onChange={(event) => setPaidAmount(event.target.value)}
              />
            </Field>
          </div>

          {/* "Pagó todo" en un tap: copia el total al abono. No guarda un flag
              aparte, así que el número y el estado no pueden contradecirse. */}
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={parsedTotal === null}
            onClick={() => setPaidAmount(totalAmount)}
          >
            Pagó todo
          </Button>

          {overpaid ? (
            <p className="text-sm font-medium text-danger">
              El abono supera el valor total.
            </p>
          ) : paymentState === "PAGADO" ? (
            <p className="text-sm font-medium text-success">Pagado completo.</p>
          ) : paymentState === "ABONADO" ? (
            <p className="text-sm text-muted-foreground">
              Abonó {formatCop(parsedPaid ?? 0)}
              {balance === null
                ? " · falta acordar el valor total"
                : ` · saldo ${formatCop(balance)}`}
            </p>
          ) : null}
        </div>

        <Field label="Nota (opcional)" htmlFor="note" className="sm:col-span-2">
          <Input id="note" name="note" placeholder="Detalle de la solicitud" />
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
