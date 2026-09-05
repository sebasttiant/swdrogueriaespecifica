"use client";

import Link from "next/link";
import { useState } from "react";
import { useActionState } from "@/lib/hooks/use-action-state";
import { LaboratorySearch } from "@/features/productos/laboratory-search";
import {
  PRESENTATION_LABEL,
  presentationLabel,
} from "@/features/pendientes/presentation";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import {
  createInventoryEntryAction,
  type EntryFormState,
} from "@/server/actions/entry.actions";

const INITIAL_STATE: EntryFormState = {
  error: null,
  ok: false,
  closedMissingCount: undefined,
};

export type ProductOption = {
  id: string;
  name: string;
  code: string;
  /**
   * Identidad en Orion, o `null` si el producto todavía no la tiene.
   *
   * La opción mostraba `nombre (código interno)`, y el código interno —`PROV-…`—
   * no significa nada del otro lado del mostrador. Con tres productos llamados
   * "Gel Caliente Muscular", "Gel Muscular Caliente" y "Gel Caliente Muscular",
   * bodega no tenía con qué distinguirlos: eligió uno, la entrada se registró
   * contra un producto que ningún pendiente esperaba, y el aviso nunca llegó.
   */
  orionCode: string | null;
  /** Lo que termina de desempatar cuando dos productos se llaman parecido. */
  laboratoryName: string | null;
  /**
   * La PRESENTACION: frasco, sobre, caja, blister, ampolla. Es `product.unit`.
   *
   * Dos filas del mismo medicamento con la misma marca se diferencian por acá.
   * Sin ella, quien recibe una caja de 30 sobres y una de 1 frasco ve el mismo
   * renglón dos veces.
   */
  unit: string;
  /** Los dos contadores que se declaran al registrar. Ver `schema.ts`. */
  identityVersion: number;
  catalogVersion: number;
};

type EntryFormProps = {
  products: ProductOption[];
  selectedProductId?: string;
  /**
   * El producto llega FIJO desde la cola de bodega y no se puede cambiar.
   *
   * Es la diferencia entre las dos formas de registrar una entrada. Cuando sale
   * de un faltante, la identidad ya está decidida por el pendiente que la
   * originó: dejar elegir de nuevo reabre exactamente el error que este camino
   * viene a cerrar. Cuando bodega registra una entrada suelta, elige — y ahí la
   * lista muestra SKU y laboratorio para que pueda hacerlo sin adivinar.
   */
  lockedProduct?: ProductOption;
  /** El faltante que originó esta entrada, para trazarla. */
  missingItemId?: string;
  // Cantidad que la cola de bodega ya sabe que falta cargar. Llega escrita para
  // que recibir una caja no obligue a recordar ni buscar cuánto se había
  // pedido; sigue siendo editable porque el proveedor a veces manda de menos.
  selectedQuantity?: number;
};

/**
 * Cómo se lee un producto en la lista.
 *
 * Nombre, SKU y laboratorio. El código interno queda afuera: `PROV-euc2` no
 * existe del otro lado del mostrador y ocupa el lugar del dato que sí
 * desempata. Sin SKU se dice "sin SKU" en vez de dejar el hueco, porque un
 * paréntesis vacío no le dice a nadie que falta cargarlo.
 */
function productLabel(product: ProductOption): string {
  const sku = product.orionCode ?? "sin SKU";
  const lab = product.laboratoryName ? ` · ${product.laboratoryName}` : "";
  return `${product.name} — ${sku} · ${presentationLabel(product.unit)}${lab}`;
}

// Alta de entrada de inventario. Único client component del slice (necesita
// useActionState). La lista de productos llega del server component que la monta.
export function EntryForm({
  products,
  selectedProductId,
  selectedQuantity,
  lockedProduct,
  missingItemId,
}: EntryFormProps) {
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  // ------------------------------------------------------------------------
  // El catálogo queda FIJADO al montar.
  //
  // `useActionState` de este repo llama a `router.refresh()` ante cualquier
  // respuesta, y también ante acciones ajenas de la misma pantalla: `products`
  // puede llegar con versiones nuevas mientras el formulario está abierto. Si
  // las versiones se leyeran de ese `products` fresco, el formulario declararía
  // una fotografía que nadie miró y el compare-and-set dejaría pasar
  // exactamente la entrada que tiene que frenar.
  //
  // La selección SÍ se sigue: se elige de esta fotografía, no de la de hoy.
  //
  // Y la lista de opciones se pinta de ACÁ, no del prop. Pintarla del prop vivo
  // dejaba la etiqueta diciendo lo nuevo y el resumen lo viejo —la misma fila
  // afirmando dos identidades—, y permitía elegir un producto recién creado que
  // la fotografía no tiene: sin él, no hay versiones que declarar y la entrada
  // moría en un error de validación que no explicaba nada.
  // ------------------------------------------------------------------------
  const [catalog] = useState(() => products);
  const [locked] = useState(() => lockedProduct);
  const [selectedId, setSelectedId] = useState(() => selectedProductId ?? "");
  // Lo que la persona decidió adoptar DESPUÉS de ver que el producto cambió.
  // Nunca se llena solo: adoptarlo en silencio dejaría pasar el reintento sin
  // que nadie haya vuelto a mirar la caja.
  const [adopted, setAdopted] = useState<
    NonNullable<EntryFormState["conflict"]> | null
  >(null);
  const [state, formAction, isPending] = useActionState(async (previousState: EntryFormState, formData: FormData) => {
    const result = await createInventoryEntryAction(previousState, formData);
    if (result.ok) setOperationId(crypto.randomUUID());
    return result;
  }, INITIAL_STATE);

  const chosen = locked ?? catalog.find((option) => option.id === selectedId);

  /**
   * La identidad adoptada pisa a la de la fotografía, en TODA la pantalla.
   *
   * Aplicarla solo al resumen dejaba la etiqueta del selector diciendo el SKU y
   * la presentación viejos mientras el renglón de abajo decía los nuevos: la
   * misma fila afirmando dos identidades a la vez. Quien tiene que cotejar
   * contra la caja no tiene forma de saber cuál de las dos es la buena, y ese
   * es exactamente el error que este slice viene a cerrar.
   */
  const withAdopted = (option: ProductOption): ProductOption =>
    // La comparacion es contra el producto DEL CONFLICTO, no contra el elegido.
    // Con `option.id === chosen?.id`, un conflicto de A adoptado mientras estaba
    // elegido B le pegaba a B la identidad de A: la pantalla mostraba A y la
    // escritura iba a B. Y cuando los dos estan en las mismas versiones —0/0 es
    // lo normal en el catalogo que nadie edito— el compare-and-set coincide y la
    // entrada entra igual.
    adopted && adopted.productId === option.id
      ? {
          ...option,
          name: adopted.name,
          orionCode: adopted.sku,
          unit: adopted.presentation,
        }
      : option;

  const shown = chosen ? withAdopted(chosen) : undefined;
  const shownSku = shown?.orionCode ?? null;
  // Pasa SIEMPRE por `presentationLabel`, venga de la fotografía o del
  // servidor: si no, un `unit` de "unidad" —relleno técnico, no un dato— se
  // mostraría como presentación real solo en el camino adoptado.
  const shownPresentation = presentationLabel(shown?.unit);

  if (catalog.length === 0) {
    return (
      <p className="text-base text-muted-foreground">
        Cargá al menos un producto en el catálogo para registrar entradas.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={operationId} />
      {/* El contrato con el servidor: contra QUÉ fotografía se registra. Las
          versiones deciden; el SKU y la presentación son lo que se vio. */}
      {chosen ? (
        <>
          <input
            type="hidden"
            name="expectedIdentityVersion"
            value={adopted ? adopted.identityVersion : chosen.identityVersion}
          />
          <input
            type="hidden"
            name="expectedCatalogVersion"
            value={adopted ? adopted.catalogVersion : chosen.catalogVersion}
          />
          <input type="hidden" name="displayedSku" value={shownSku ?? ""} />
          <input
            type="hidden"
            name="displayedPresentation"
            value={shownPresentation}
          />
        </>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {locked ? (
          <Field label="Producto" className="sm:col-span-2">
            {/* Hidden y no `disabled`: un campo deshabilitado NO entra en el
                FormData, y la entrada se enviaría sin producto. */}
            <input type="hidden" name="productId" value={locked.id} />
            {missingItemId ? (
              <input type="hidden" name="missingItemId" value={missingItemId} />
            ) : null}
            <div className="rounded-lg border border-border bg-muted px-3 py-2">
              <p className="font-medium text-text">{shown?.name ?? locked.name}</p>
              <p className="text-xs text-muted-foreground">
                SKU (código de Orion):{" "}
                <span className="font-mono">{shownSku ?? "sin asignar"}</span>
                {locked.laboratoryName ? ` · ${locked.laboratoryName}` : ""}
              </p>
              {/* La presentación va en su propio renglón y con su rótulo: es lo
                  que distingue un frasco de una caja de 30 sobres del mismo
                  medicamento, y leerla pegada al SKU la vuelve invisible. */}
              <p className="text-xs text-muted-foreground">
                {PRESENTATION_LABEL}: {shownPresentation}
              </p>
              {/* Se dice POR QUÉ no se puede cambiar. Un campo bloqueado sin
                  explicación se lee como una falla de la pantalla. */}
              <p className="mt-1 text-xs text-muted-foreground">
                Viene del faltante que estás recibiendo. No se puede cambiar.
              </p>
            </div>
          </Field>
        ) : (
          <Field label="Producto" htmlFor="productId" className="sm:col-span-2">
            <Select
              id="productId"
              name="productId"
              required
              value={selectedId}
              onChange={(event) => {
                setSelectedId(event.target.value);
                // Cambiar de producto tira la adopción: pertenecía al anterior.
                setAdopted(null);
              }}
            >
              <option value="">Elegí un producto…</option>
              {catalog.map((product) => (
                <option key={product.id} value={product.id}>
                  {productLabel(withAdopted(product))}
                </option>
              ))}
            </Select>
            {chosen ? (
              <p className="mt-2 text-xs text-muted-foreground">
                SKU: <span className="font-mono">{shownSku ?? "sin asignar"}</span>
                {" · "}
                {PRESENTATION_LABEL}: {shownPresentation}
              </p>
            ) : null}
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
            defaultValue={selectedQuantity ?? 1}
          />
        </Field>
        <Field label="Código de lote" htmlFor="batchCode">
          <Input
            id="batchCode"
            name="batchCode"
            placeholder="Ej: LOTE-2026-001"
            required
            // Cuando se viene desde la cola de bodega, producto y cantidad ya
            // llegan resueltos: el cursor arranca donde sí hay que escribir,
            // que es lo único que se lee de la caja.
            autoFocus={selectedProductId !== undefined}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Si el lote ya existe para este producto, se suma la cantidad.
          </p>
        </Field>
        {/* Solo fecha. Un vencimiento se dice por día —"vence el 31 de
            diciembre"— y la hora era un campo más que había que completar sin
            que nadie la leyera después. `expiryLevel` ya compara fechas de
            calendario, así que sacarla no cambia el semáforo. */}
        <Field label="Fecha de vencimiento" htmlFor="expiresAt">
          <Input id="expiresAt" name="expiresAt" type="date" required />
        </Field>
        {/* Laboratorio de lo que LLEGÓ, que no siempre es el que se pidió.
            Es evidencia de la recepción: el servicio la compara contra el lote
            bajo lock y crea el laboratorio si el nombre es nuevo, que es el
            caso normal con un proveedor que recién empieza a traer.

            Va sin `required` a propósito. Si el remito no lo aclara, exigirlo
            frenaría una recepción real por un dato que bodega no tiene en la
            mano — y la mercadería ya está en el depósito igual. */}
        <div className="sm:col-span-2">
          <LaboratorySearch
            name="receivedLaboratoryId"
            nameForLabel="receivedLaboratoryName"
            label="Laboratorio de lo recibido (opcional)"
            hint="Si el remito no lo aclara, dejalo vacío. Si es uno nuevo, escribilo igual."
          />
        </div>
        <Field label="Nota (opcional)" htmlFor="note" className="sm:col-span-2">
          <Input
            id="note"
            name="note"
            placeholder="Observaciones de la recepción"
          />
        </Field>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.resolveSkuForProductId ? (
        /* El enlace lleva al producto EXACTO. Sin él, "completalo en Productos"
           obliga a buscarlo entre nombres parecidos — el mismo problema. */
        <p className="text-sm">
          <Link
            prefetch={false}
            href={`/productos/${state.resolveSkuForProductId}`}
            className="font-semibold text-primary underline underline-offset-2"
          >
            Ir a completar el SKU
          </Link>
        </p>
      ) : null}
      {state.conflict && state.conflict.productId === chosen?.id && !adopted ? (
        /* El borrador NO se toca: cantidad, lote y vencimiento siguen escritos.
           Lo único obsoleto es la referencia al producto, y adoptarla es una
           decisión que toma la persona después de mirar la caja. */
        <Button
          type="button"
          variant="secondary"
          onClick={() => setAdopted(state.conflict ?? null)}
        >
          Usar los datos actualizados
        </Button>
      ) : null}
      {adopted ? (
        <p role="status" className="text-sm text-muted-foreground">
          Datos actualizados. Verifica el SKU y la presentación, y confirma la
          entrada.
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          {state.closedMissingCount && state.closedMissingCount > 0
            ? `Entrada registrada. Se cerraron ${state.closedMissingCount} faltante${state.closedMissingCount === 1 ? "" : "s"} de este producto.`
            : "Entrada registrada correctamente."}
        </p>
      ) : null}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Guardando…" : "Registrar entrada"}
      </Button>
    </form>
  );
}
