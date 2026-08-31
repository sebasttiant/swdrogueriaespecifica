"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { LaboratorySearch } from "@/features/productos/laboratory-search";
import { Select } from "@/app/_components/ui/select";
import { newAttemptKey } from "@/features/pendientes/attempt-key";
import {
  buildPromisedAtOptions,
  defaultPromisedAtValue,
} from "@/features/pendientes/promised-at-options";
import {
  derivePaymentState,
  remainingAmount,
} from "@/features/pendientes/payment-state";
import {
  MAX_IDENTITY_DEFERRAL_NOTE_LENGTH,
  PENDING_IDENTITY_DEFERRAL_LABELS,
  PENDING_IDENTITY_DEFERRAL_REASONS,
} from "@/features/pendientes/identity-deferral";
import { ORION_CODE_MAX_CHARS } from "@/server/domain/catalog/sku-identity";
import { MAX_ZONE_LENGTH } from "@/features/pendientes/zone";
import { MAX_PHONE_INPUT_LENGTH } from "@/features/pendientes/phone";
import {
  PRESENTATION_LABEL,
  hasPresentation,
  presentationLabel,
} from "@/features/pendientes/presentation";
import { cn } from "@/lib/utils/cn";
import { formatCop, parseCopInput } from "@/lib/format/currency";
import {
  createPendingAction,
  type PendingFormState,
  type PendingSubmittedValues,
} from "@/server/actions/pending.actions";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

// Cuánto puede tardar un registro antes de que valga la pena decirle algo a la
// persona. Por debajo de esto, avisar sería ruido; por encima, el silencio hace
// que reintente —y un reintento a ciegas es como nacen los duplicados.
//
// Estaba en 15 s, calibrado para un proceso de fondo. Esto es un MOSTRADOR: el
// vendedor tiene al cliente delante y un botón que gira quince segundos sin
// decir nada no se lee como "está tardando", se lee como "se colgó". A los 3 s
// ya se percibe la demora y todavía falta muchísimo para el timeout de
// recuperación, así que el aviso llega cuando sirve y no compite con él.
const SLOW_SUBMIT_MS = 3_000;

// Timeout de recuperación: si la acción no resuelve después de este tiempo, el
// formulario se resetea para que el operador pueda reintentar. Es seguro porque
// el idempotencyKey garantiza que un segundo envío no duplica el pendiente.
const STUCK_TIMEOUT_MS = 60_000;

export type ProductOption = {
  id: string;
  name: string;
  code: string;
  /**
   * Identidad en Orion, o `null` si el producto todavía no la tiene.
   *
   * Es lo que el vendedor puede cotejar contra la pantalla del ERP que ya tiene
   * abierta. El `code` interno (`PROV-…`, `MED-001`) no existe del otro lado.
   */
  orionCode: string | null;
  /**
   * La presentación guardada en el catálogo: frasco, sobre, caja, ampolla.
   *
   * Viaja para MOSTRARSE, nunca para editarse desde acá. El catálogo es
   * información compartida y esta es una pantalla de captura: un vendedor que
   * corrige la presentación de un producto se la cambia a todos, en todos los
   * pedidos, incluidos los que ya están cargados.
   */
  unit: string;
};

// De 30 referencias de Eucerin, el nombre no distingue ninguna. Lo que las
// distingue es el código de Orion, así que va en la etiqueta y no escondido.
// Cuando falta se dice: un producto sin identidad es trabajo pendiente, no un
// detalle que convenga tapar.
export function optionLabel(product: ProductOption): string {
  return `${product.name} · ${product.orionCode ?? "sin SKU"}`;
}

type PendingFormProps = {
  products: ProductOption[];
  // Zonas ya usadas, para sugerir en vez de obligar a recordar cómo se escribió.
  // Sugerencia, no restricción: una zona nueva se escribe igual de rápido.
  zones?: string[];
  // Inyectables para tests deterministas; en producción usan los defaults.
  now?: Date;
  defaultCustom?: boolean;
};

/**
 * Alta de pendiente.
 *
 * CONTRATO ÉXITO/ERROR — la razón por la que este componente está partido en dos:
 *
 * React limpia los campos no controlados de un `<form action={fn}>` en cuanto la
 * acción resuelve, sin mirar QUÉ devolvió. Un error devuelto es una resolución,
 * así que el formulario se vaciaba también al fallar y había que tipear todo de
 * nuevo para reintentar. Ese fue el incidente.
 *
 * Acá el vaciado no se delega a ese reset: se decide explícitamente.
 *
 *   - `PendingForm` (este) sostiene el estado de la acción, que sobrevive.
 *   - `PendingFormFields` se REMONTA en cada respuesta, con `key={submissionId}`.
 *
 * Al remontar, cada campo toma su `defaultValue` de `state.values`:
 *
 *   - fallo  -> `values` trae el eco de lo enviado -> los campos vuelven llenos.
 *   - éxito  -> `values` viene ausente             -> los campos quedan vacíos.
 *
 * Como `submissionId` es distinto en cada respuesta, la limpieza ocurre una sola
 * vez por éxito y los valores de un intento anterior no pueden reaparecer.
 */
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

  return (
    <PendingFormFields
      key={state.submissionId ?? "initial"}
      products={products}
      zones={zones}
      now={now}
      defaultCustom={defaultCustom}
      formAction={formAction}
      isPending={isPending}
      state={state}
    />
  );
}

type PendingFormFieldsProps = PendingFormProps & {
  zones: string[];
  now: Date;
  defaultCustom: boolean;
  formAction: (formData: FormData) => void;
  isPending: boolean;
  state: PendingFormState;
};

function PendingFormFields({
  products,
  zones,
  now,
  defaultCustom,
  formAction,
  isPending,
  state,
}: PendingFormFieldsProps) {
  // El eco del intento anterior cuando falló; ausente tras un éxito o al entrar.
  const previous: Partial<PendingSubmittedValues> = state.values ?? {};

  const conflict = state.orionConflict;
  const canSelectExisting = products.length > 0;
  // Modo manual: producto que no está en el catálogo. Si no hay catálogo cargado,
  // el manual es la única vía, así que arranca activo y sin opción de togglear.
  // Tras un fallo se respeta el modo en el que se estaba cargando.
  const [manual, setManual] = useState(
    previous.manualMode ? previous.manualMode === "on" : !canSelectExisting,
  );
  const manualToggleId = useId();

  // Clave de idempotencia del intento. Se conserva mientras el registro falle
  // —así el reintento no crea un segundo pendiente— y nace nueva tras un éxito,
  // porque el remonte descarta este estado junto con los campos.
  const [attemptKey] = useState(() => previous.idempotencyKey || newAttemptKey());

  // --------------------------------------------------------------------------
  // Identidad Orion (S2b).
  //
  // El selector pasa a ser CONTROLADO porque la pantalla tiene que reaccionar a
  // qué producto se eligió: al que ya tiene código se le muestra el suyo y NO
  // se le vuelve a preguntar. Preguntar de nuevo por un dato que el sistema ya
  // sabe es cómo se entrena a la gente a tipear cualquier cosa para sacarse el
  // campo de encima, y un código inventado es peor que ninguno.
  // --------------------------------------------------------------------------
  const [productId, setProductId] = useState(previous.productId ?? "");
  const selectedProduct = products.find((product) => product.id === productId);

  // Este draft es controlado porque su identidad de producto puede cambiar sin
  // que el bloque se desmonte. Un `defaultValue` conservaría datos del producto
  // anterior y terminaría posteándolos para el siguiente.
  const [orionCode, setOrionCode] = useState(previous.orionCode ?? "");
  const [identitySkippedReason, setIdentitySkippedReason] = useState(
    previous.identitySkippedReason ?? "",
  );
  const [identitySkippedNote, setIdentitySkippedNote] = useState(
    previous.identitySkippedNote ?? "",
  );
  const [showConflictRecovery, setShowConflictRecovery] = useState(conflict != null);
  const conflictHolder = conflict
    ? products.find((product) => product.id === conflict.holder.productId)
    : undefined;

  // El manual SIEMPRE pide identidad: todavía no existe, así que no puede
  // traer un código de antes.
  const asksIdentity = manual || (selectedProduct != null && !selectedProduct.orionCode);

  // La salida por aplazamiento. Vuelve ABIERTA tras un fallo si ya se había
  // elegido un motivo: obligar a tildarla de nuevo para ver lo elegido haría
  // que el eco no sirviera de nada.
  const [deferred, setDeferred] = useState(Boolean(previous.identitySkippedReason));
  const deferToggleId = useId();

  const clearIdentityDraft = () => {
    setOrionCode("");
    setDeferred(false);
    setIdentitySkippedReason("");
    setIdentitySkippedNote("");
    setShowConflictRecovery(false);
  };

  const changeManualMode = (nextManual: boolean) => {
    if (nextManual === manual) return;
    clearIdentityDraft();
    setManual(nextManual);
  };

  const changeProduct = (nextProductId: string) => {
    if (nextProductId === productId) return;
    clearIdentityDraft();
    setProductId(nextProductId);
  };

  const selectConflictHolder = () => {
    if (!conflictHolder) return;
    clearIdentityDraft();
    setManual(false);
    setProductId(conflictHolder.id);
  };

  const deferConflict = () => {
    setOrionCode("");
    setDeferred(true);
    setIdentitySkippedReason("CODE_ALREADY_ASSIGNED");
    setIdentitySkippedNote("");
    setShowConflictRecovery(false);
  };

  // Cómo se envió: Enter o clic. Solo para el diagnóstico del servidor; no
  // cambia ninguna decisión de negocio.
  const submitMethodRef = useRef<HTMLInputElement>(null);
  const markSubmitMethod = (method: "enter" | "click") => {
    if (submitMethodRef.current) submitMethodRef.current.value = method;
  };

  // Entrega prometida: atajos rápidos (el caso común) + un modo personalizado
  // que muestra el `datetime-local` de siempre (el caso raro). El valor viaja
  // como `promisedAt` sin cambiar el contrato del backend.
  const promisedAtOptions = buildPromisedAtOptions(now);
  const [promisedAt, setPromisedAt] = useState(
    () => previous.promisedAt || defaultPromisedAtValue(now),
  );
  const [customPromisedAt, setCustomPromisedAt] = useState(defaultCustom);
  const promisedAtCustomId = useId();

  // Montos como TEXTO, no como number: el operador escribe "45.000" con el punto
  // de miles y un <input type="number"> lo rechazaría. El texto se interpreta
  // con `parseCopInput`, el mismo lector que usa el servidor.
  const [totalAmount, setTotalAmount] = useState(previous.totalAmount ?? "");
  const [paidAmount, setPaidAmount] = useState(previous.paidAmount ?? "");
  const zonesListId = useId();

  const parsedTotal = parseCopInput(totalAmount);
  const parsedPaid = parseCopInput(paidAmount);
  const payment = { totalAmount: parsedTotal, paidAmount: parsedPaid ?? 0 };
  const paymentState = derivePaymentState(payment);
  const balance = remainingAmount(payment);
  // El abono sobre un total conocido nunca debería superarlo; se avisa mientras
  // se escribe en vez de esperar al rechazo del servidor.
  const overpaid = parsedTotal !== null && parsedPaid !== null && parsedPaid > parsedTotal;

  // "Guardando…" que no termina: si el servidor no contesta, el botón girando no
  // le dice nada a nadie y la persona reintenta. Este aviso le da la única
  // instrucción segura —esperar, no reintentar— porque el registro puede haber
  // quedado hecho igual.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!isPending) return;
    const timer = setTimeout(() => setSlow(true), SLOW_SUBMIT_MS);
    return () => clearTimeout(timer);
    // No hace falta apagar el aviso al terminar: cuando llega una respuesta
    // cambia `submissionId`, este componente se remonta entero y `slow` nace de
    // nuevo en false. Apagarlo a mano acá sería un render en cascada redundante.
  }, [isPending]);

  // Timeout de recuperación: si la acción lleva más de STUCK_TIMEOUT_MS sin
  // resolver, el operador puede forzar un re-intento. Es seguro porque el
  // idempotencyKey garantiza que un segundo envío no duplica el pendiente.
  // No hace falta apagar el aviso al terminar: al resolverse la acción cambia
  // submissionId y este componente se remonta entero, reseteando stuck a false.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!isPending) return;
    const timer = setTimeout(() => setStuck(true), STUCK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isPending]);

  return (
    <form
      action={formAction}
      className="space-y-4"
      // Submit implícito del navegador: Enter dentro de un campo. Se marca acá
      // porque en ese camino no hay clic en el botón que lo registre.
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          markSubmitMethod("enter");
        }
      }}
    >
      <input type="hidden" name="idempotencyKey" value={attemptKey} />
      <input
        ref={submitMethodRef}
        type="hidden"
        name="submitMethod"
        defaultValue="unknown"
      />
      <input type="hidden" name="manualMode" value={manual ? "on" : "off"} />

      {canSelectExisting ? (
        <label
          htmlFor={manualToggleId}
          className="flex items-center gap-2 text-sm font-medium text-text"
        >
          <input
            id={manualToggleId}
            type="checkbox"
            checked={manual}
            onChange={(event) => changeManualMode(event.target.checked)}
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
                defaultValue={previous.manualName ?? ""}
              />
            </Field>
            {/* Presentación de un producto que NO está en el catálogo: acá SÍ
                se escribe, porque el producto se está creando en este mismo
                gesto y todavía no hay dato compartido que pisar. Sigue siendo
                opcional; `schema.ts` completa "unidad" cuando queda vacía. */}
            <Field
              label={`${PRESENTATION_LABEL} (opcional)`}
              htmlFor="manualUnit"
              className="sm:col-span-2"
              hint="Cómo viene el producto: Frasco, Sobre, Caja, Blíster, Ampolla."
            >
              <Input
                id="manualUnit"
                name="manualUnit"
                maxLength={40}
                placeholder="Frasco"
                defaultValue={previous.manualUnit ?? ""}
              />
            </Field>
          </>
        ) : (
          <Field label="Producto" htmlFor="productId" className="sm:col-span-2">
            <Select
              id="productId"
              name="productId"
              required
              value={productId}
              onChange={(event) => changeProduct(event.target.value)}
            >
              <option value="">Elegí un producto…</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {optionLabel(product)}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {/* Presentación del producto del CATÁLOGO: se muestra, no se edita.
            Es el mismo bloque de solo lectura que el código de Orion de abajo,
            a propósito: los dos son datos del producto que el vendedor consulta
            para decidir, y ninguno de los dos se toca desde esta pantalla.

            Nunca bloquea la carga del pendiente: un producto sin presentación
            se puede pedir igual, y por eso dice "Sin presentación" en vez de
            pedir que se complete algo. */}
        {!manual && selectedProduct ? (
          <div className="sm:col-span-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">{PRESENTATION_LABEL}: </span>
            <span
              className={cn(
                "break-words",
                hasPresentation(selectedProduct.unit)
                  ? "font-medium text-text"
                  : "text-muted-foreground",
              )}
            >
              {presentationLabel(selectedProduct.unit)}
            </span>
          </div>
        ) : null}

        {/* Identidad Orion. Tres estados EXCLUYENTES: el producto ya la tiene
            (se muestra), hace falta (se pide), o se sigue sin ella (se explica
            por qué). Nunca dos a la vez. */}
        {!manual && selectedProduct?.orionCode ? (
          <div className="sm:col-span-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Código de Orion: </span>
            <span className="font-medium text-text">{selectedProduct.orionCode}</span>
          </div>
        ) : null}

        {asksIdentity ? (
          <div className="sm:col-span-2 grid gap-3">
            {deferred ? null : (
              <Field
                label="Código de Orion"
                htmlFor="orionCode"
                hint="El que ves en la pantalla de Orion para este producto."
              >
                <Input
                  id="orionCode"
                  name="orionCode"
                  // Obligatorio, y esa es toda la novedad de esta rebanada: el
                  // campo ya se veía, pero se podía dejar vacío. La exigencia
                  // de verdad vive en la acción —esto se saltea armando el
                  // FormData a mano—; acá está para que se descubra ANTES de
                  // mandar el pedido entero, no después. La salida sigue a un
                  // clic: al tildar "seguir sin el código" este campo se va, y
                  // con él su obligatoriedad.
                  required
                  maxLength={ORION_CODE_MAX_CHARS}
                  placeholder="Ej: 100234"
                  value={orionCode}
                  onChange={(event) => {
                    setOrionCode(event.target.value);
                    setShowConflictRecovery(false);
                  }}
                />
              </Field>
            )}

            {/* La salida existe porque el mostrador NO puede depender del ERP:
                hay un cliente enfrente y el pendiente tiene que poder cargarse
                igual. Lo que no puede es cargarse sin decir por qué. */}
            <label
              htmlFor={deferToggleId}
              className="flex items-center gap-2 text-sm font-medium text-text"
            >
              <input
                id={deferToggleId}
                type="checkbox"
                checked={deferred}
                  onChange={(event) => {
                    const nextDeferred = event.target.checked;
                    setShowConflictRecovery(false);
                    setDeferred(nextDeferred);
                  if (nextDeferred) {
                    setOrionCode("");
                  } else {
                    setIdentitySkippedReason("");
                    setIdentitySkippedNote("");
                  }
                }}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              Continuar sin SKU (código de Orion)
            </label>

            {deferred ? (
              <>
                <Field label="¿Por qué continuás sin SKU?" htmlFor="identitySkippedReason">
                  <Select
                    id="identitySkippedReason"
                    name="identitySkippedReason"
                    required
                    value={identitySkippedReason}
                    onChange={(event) => {
                      setIdentitySkippedReason(event.target.value);
                      setShowConflictRecovery(false);
                    }}
                  >
                    <option value="">Elegí un motivo…</option>
                    {PENDING_IDENTITY_DEFERRAL_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {PENDING_IDENTITY_DEFERRAL_LABELS[reason]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Nota del aplazamiento (opcional)"
                  htmlFor="identitySkippedNote"
                >
                  <textarea
                    id="identitySkippedNote"
                    name="identitySkippedNote"
                    rows={2}
                    maxLength={MAX_IDENTITY_DEFERRAL_NOTE_LENGTH}
                    value={identitySkippedNote}
                    onChange={(event) => {
                      setIdentitySkippedNote(event.target.value);
                      setShowConflictRecovery(false);
                    }}
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text"
                  />
                </Field>
              </>
            ) : null}
          </div>
        ) : null}

        <Field label="Cantidad" htmlFor="quantity">
          <Input
            id="quantity"
            name="quantity"
            type="number"
            min={1}
            step={1}
            required
            defaultValue={previous.quantity || 1}
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
            placeholder="El Poblado, Laureles, Belén…"
            defaultValue={previous.zone ?? ""}
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
            defaultValue={previous.customerName ?? ""}
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
            defaultValue={previous.customerPhone ?? ""}
          />
        </Field>
        {/* Dirección de entrega: opcional. La zona ya da el ruteo grueso; esto
            afina dónde entregar. Ocupa las dos columnas: una dirección no entra
            cómoda en media fila. */}
        <Field label="Dirección (opcional)" htmlFor="customerAddress" className="sm:col-span-2">
          <Input
            id="customerAddress"
            name="customerAddress"
            autoComplete="street-address"
            maxLength={200}
            placeholder="Calle 10 #43-20, apto 301"
            defaultValue={previous.customerAddress ?? ""}
          />
        </Field>
        {/* T3: Laboratorio solicitado por el cliente. OPCIONAL: el vendedor
            tiene al cliente delante y muchas veces no lo sabe; frenar la venta
            por un dato que se completa después pierde el pedido, que es lo
            único que esta pantalla existe para no perder.
            Autocomplete con búsqueda normalizada (T2). */}
        <div className="sm:col-span-2">
          <LaboratorySearch
            name="requestedLaboratoryId"
            nameForLabel="requestedLaboratoryName"
            label="Laboratorio solicitado (opcional)"
            hint="Si no lo conocés, podés dejarlo vacío."
            defaultSelectedId={previous.requestedLaboratoryId}
            defaultSelectedName={previous.requestedLaboratoryName}
          />
        </div>
        {/* Pago: dos montos y NADA más. El "pagado totalmente" no es un campo,
            es el resultado de que el abono cubra el total — se muestra abajo. */}
        <div className="space-y-3 sm:col-span-2">
          <span className="text-sm font-medium text-text">Pago (opcional)</span>
          <div className="grid gap-4 sm:grid-cols-2">
            {/* La pista NO es decorativa: es la corrección de fondo del
                incidente. El campo solo mostraba "$ 45.000" y nadie podía
                adivinar que vacío era una opción válida, así que quien no sabía
                el precio escribía "0" — y ese cero rompía el registro. Decirlo
                acá evita la confusión en el origen; el aviso posterior es la red,
                no la solución. */}
            <Field
              label="Valor total"
              htmlFor="totalAmount"
              hint="Si todavía no lo sabés, dejalo vacío."
            >
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
          <Input
            id="note"
            name="note"
            placeholder="Detalle de la solicitud"
            defaultValue={previous.note ?? ""}
          />
        </Field>
      </div>

      {state.error ? (
        <div role="alert" className="space-y-2 rounded-md border border-danger/40 p-3">
          <p className="text-sm font-medium text-danger">{state.error}</p>
          <p className="text-sm text-muted-foreground">
            Los datos siguen cargados. Podés volver a intentar sin escribirlos de
            nuevo.
          </p>
          {showConflictRecovery && conflict ? (
            <div className="flex flex-wrap gap-2">
              {conflictHolder ? (
                <Button type="button" onClick={selectConflictHolder}>
                  Usar {conflict.holder.productName}
                </Button>
              ) : (
                <p className="w-full text-sm text-muted-foreground">
                  El producto dueño no está disponible en esta lista. Recargá antes de
                  seleccionarlo.
                </p>
              )}
              <Button type="button" variant="secondary" onClick={deferConflict}>
                Mantener este producto y aplazar
              </Button>
              {!conflictHolder ? (
                <Button type="button" variant="ghost" onClick={() => window.location.reload()}>
                  Recargar productos
                </Button>
              ) : null}
            </div>
          ) : null}
          {state.supportCode ? <SupportCode code={state.supportCode} /> : null}
        </div>
      ) : null}
      {state.ok ? (
        <div role="status" className="space-y-1">
          <p className="text-sm font-medium text-success">Pendiente registrado.</p>
          {/* El operador escribió un valor total y el sistema lo guardó como
              desconocido. Escribió una cosa y se guardó otra: callarlo llevaría a
              que alguien jure que cargó el precio y el listado diga que no, sin
              forma de saber quién tiene razón. */}
          {state.savedWithoutTotalAmount ? (
            <p className="text-sm text-muted-foreground">
              Quedó <strong>sin valor total</strong>: cuando sepas el precio,
              corregilo desde el listado.
            </p>
          ) : null}
        </div>
      ) : null}
      {slow ? (
        <p role="status" className="text-sm font-medium text-warning">
          Está tardando más de lo normal. Esperá sin cerrar esta pantalla: si el
          pendiente ya quedó guardado, volver a enviarlo NO lo duplica, pero
          conviene esperar la respuesta antes de reintentar.
        </p>
      ) : null}
      {stuck ? (
        <div role="alert" className="space-y-2 rounded-md border border-danger/40 p-3">
          <p className="text-sm font-medium text-danger">
            La conexión se cortó o el servidor no respondió. El pendiente pudo
            haber quedado guardado.
          </p>
          <p className="text-sm text-muted-foreground">
            Si cargás el mismo pendiente de nuevo, el sistema lo detecta y no lo
            duplica.
          </p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => window.location.reload()}
            className="min-h-11"
          >
            Recargar y volver a intentar
          </Button>
        </div>
      ) : null}

      <Button
        type="submit"
        disabled={isPending}
        // Enter dentro de un campo NO es un camino aparte: el navegador lo
        // resuelve haciendo clic en este botón, así que este handler corre
        // también en ese caso y pisaría la marca del `onKeyDown`.
        //
        // `detail` los separa: un clic real del puntero trae el contador de
        // clics (>= 1); uno sintetizado desde el teclado trae 0.
        onClick={(event) => {
          if (event.detail > 0) markSubmitMethod("click");
        }}
      >
        {isPending ? "Guardando…" : "Registrar pendiente"}
      </Button>
    </form>
  );
}

/**
 * Código de soporte con copiado en un toque.
 *
 * El operador está en el mostrador con un cliente enfrente: leer y dictar seis
 * caracteres sin equivocarse es justo lo que no va a pasar. El botón copia; el
 * texto queda igual visible para quien prefiera dictarlo.
 */
function SupportCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // `navigator.clipboard` puede no existir (contexto no seguro, como entrar
      // directo al puerto del VPS) o el permiso puede estar denegado. Que falle
      // no rompe nada: el código sigue en pantalla para leerlo o dictarlo, que
      // es para lo que existe.
      setCopied(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <code className="rounded bg-surface px-2 py-1 font-mono text-sm">{code}</code>
      <Button type="button" variant="ghost" onClick={copy} className="min-h-11">
        {copied ? "Copiado" : "Copiar código"}
      </Button>
    </div>
  );
}
