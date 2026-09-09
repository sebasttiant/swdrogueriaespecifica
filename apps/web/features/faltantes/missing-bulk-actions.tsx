"use client";

import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
import {
  discardMissingItemsAction,
  markMissingItemsOrderedAction,
  type MissingItemActionState,
} from "@/server/actions/missing-item.actions";
import { MISSING_BULK_FORM_ID } from "./missing-bulk-selection";

const INITIAL_STATE: MissingItemActionState = { error: null, ok: false };

export type MissingBulkActionsProps = {
  // Ids elegibles de ESTA página: lo mínimo que la barra necesita para operar
  // ("Seleccionar todos" y el total). Dibujar las filas NO es trabajo suyo —
  // eso es lo que este cambio vino a corregir: la barra dibujaba su propia
  // copia de la cola justo encima de la lista real, y la misma información
  // aparecía dos veces en la misma pantalla, en un celular.
  eligibleIds: string[];
  // La lista real (`MissingList` en modo masivo). Cada fila elegible ya monta
  // su propia casilla, asociada a `MISSING_BULK_FORM_ID`
  // por el atributo `form` de HTML — nunca por anidamiento: los formularios no
  // se anidan, y cada fila ya monta los dos `<form>` de `MissingQuickActions`.
  //
  // Opcional solo para que `createElement(MissingBulkActions, props, child)`
  // tipe en los tests `.test.ts` (sin JSX); en la pantalla real siempre viaja.
  children?: ReactNode;
};

/**
 * Barra de selección masiva sobre la cola. Resuelve literalmente lo que pidió
 * el gerente: "no, okay, borrame del uno al 80".
 *
 * Ofrece las DOS salidas, con textos opuestos y en un ÚNICO `<form>` —una
 * casilla solo puede pertenecer a un formulario, así que los dos formularios
 * separados de antes no sobreviven a que la casilla viva en la fila—:
 *
 *   ✓ Ya lo pedí → gerencia ya lo compró; la mercadería viene en camino.
 *   ✗ Descartar          → nadie lo va a pedir (duplicado o ya no hace falta).
 *
 * Siguen siendo dos acciones distintas, nunca un "OK" ambiguo: esa ambigüedad
 * es la que ya hubo que revertir una vez. "Ya lo pedí" es el submit por
 * defecto del formulario (más usado, decenas de veces por día); "Descartar"
 * pisa el destino con `formAction`.
 *
 * El conteo y "Seleccionar todos" leen el DOM (`FormData`/`form.elements`) en
 * vez de un estado espejo en React: las casillas de cada fila son NO
 * controladas y viven fuera de este componente (llegan dibujadas dentro de
 * `children`), así que un estado de React acá nunca se enteraría de un clic
 * en una de ellas sin este truco de delegación.
 *
 * La página monta esto solo para la autoridad de compras; ambas Server Actions
 * revalidan la capacidad del lado del servidor de todas formas.
 */
export function MissingBulkActions({ eligibleIds, children }: MissingBulkActionsProps) {
  const [orderState, orderAction, isOrdering] = useActionState(
    markMissingItemsOrderedAction,
    INITIAL_STATE,
  );
  const [discardState, discardAction, isDiscarding] = useActionState(
    discardMissingItemsAction,
    INITIAL_STATE,
  );
  const reasonId = useId();
  // Solo pinta el contador y "Seleccionar todos": la fuente de verdad sigue
  // siendo el DOM. Sin este espejo, cada clic en una fila real forzaría un
  // "levantar el estado" hasta acá, que es justo el acoplamiento que la
  // delegación de eventos evita.
  const [selectedCount, setSelectedCount] = useState(0);

  function getForm(): HTMLFormElement | null {
    if (typeof document === "undefined") return null;
    return document.getElementById(MISSING_BULK_FORM_ID) as HTMLFormElement | null;
  }

  function countChecked(): number {
    const form = getForm();
    return form ? new FormData(form).getAll("ids").length : 0;
  }

  function selectionControls(form: HTMLFormElement): HTMLInputElement[] {
    return Array.from(form.elements).filter(
      (element): element is HTMLInputElement =>
        element instanceof HTMLInputElement &&
        element.type === "checkbox" && eligibleIds.includes(element.value),
    );
  }

  // Mobile y desktop siguen montados: reflejan la misma selección, pero solo
  // la primera casilla de cada ítem aporta un valor al formulario externo.
  // Las demás conservan `form` y siguen siendo interactivas, sin depender del ancho.
  function synchronizeSelection(form: HTMLFormElement, changed?: HTMLInputElement) {
    const seen = new Set<string>();
    for (const control of selectionControls(form)) {
      if (changed && control.value === changed.value) control.checked = changed.checked;
      control.name = seen.has(control.value) ? "" : "ids";
      seen.add(control.value);
    }
  }

  // Delegación: las casillas de las filas viven fuera de este componente, así
  // que un `onChange` en cada una no es una opción. Escuchando en el
  // contenedor que envuelve `children`, cualquier cambio en cualquier fila
  // burbujea hasta acá y el conteo se relee del DOM.
  function handleContainerChange(event: ChangeEvent<HTMLDivElement>) {
    const form = getForm();
    const changed = event.target;
    if (form && changed instanceof HTMLInputElement && changed.type === "checkbox" && changed.form === form) {
      synchronizeSelection(form, changed);
    }
    setSelectedCount(countChecked());
  }

  function toggleAll(event: ChangeEvent<HTMLInputElement>) {
    // Esta casilla vive DENTRO del contenedor que escucha `onChange` para
    // delegar el conteo de las filas (`handleContainerChange`). Sin cortar la
    // burbuja acá, un solo clic dispara los dos handlers y `setSelectedCount`
    // corre dos veces por el mismo evento — converge al mismo valor, pero es
    // una renderización de más que no cuesta nada evitar.
    event.stopPropagation();
    const form = getForm();
    if (!form) return;
    const shouldCheck = countChecked() < eligibleIds.length;
    // `HTMLFormControlsCollection` no trae iterador en los tipos de TS
    // (aunque el runtime sí lo soporta): `Array.from` lo recorre sin pelear
    // con el compilador.
    for (const element of selectionControls(form)) {
      element.checked = shouldCheck;
    }
    synchronizeSelection(form);
    setSelectedCount(shouldCheck ? eligibleIds.length : 0);
  }

  // Sin nada elegible en esta página, la barra no tiene qué ofrecer — pero la
  // lista real sigue existiendo debajo. No es dueña de decidir si se muestra.
  if (eligibleIds.length === 0) return <>{children}</>;

  const allSelected = selectedCount === eligibleIds.length;

  return (
    <div
      className="space-y-3 rounded-lg border border-border p-3"
      onChange={handleContainerChange}
    >
      {/* UN solo formulario: una casilla solo puede pertenecer a uno, y la
          casilla de cada fila ya eligió este por su atributo `form`. */}
      <form id={MISSING_BULK_FORM_ID} action={orderAction} className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm font-medium text-text">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            Seleccionar todos ({eligibleIds.length})
          </label>
          {selectedCount > 0 ? (
            <span className="text-sm text-muted-foreground">
              {selectedCount} seleccionado{selectedCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        {/* Motivo del descarte. Viaja TAMBIÉN en el submit de "Ya lo pedí"
            porque comparten este único formulario, pero `markMissingItemsOrderedAction`
            arma su input a mano con solo `ids` y nunca reenvía este campo. */}
        <div className="space-y-1.5">
          <label htmlFor={reasonId} className="text-sm font-medium text-text">
            Motivo (opcional)
          </label>
          <Input
            id={reasonId}
            name="reason"
            maxLength={200}
            placeholder="Duplicado, ya no se necesita…"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Acción principal: "ya lo pedí". Es la que el gerente usa decenas
              de veces por día, así que es el submit POR DEFECTO del
              formulario (sin `formAction` propio). */}
          <Button type="submit" disabled={isOrdering || selectedCount === 0}>
            {isOrdering ? "Marcando…" : `Ya lo pedí ${selectedCount || ""}`.trim()}
          </Button>

          {/* Descarte: pisa el destino del envío con `formAction`, sin tocar
              el del botón de arriba. */}
          <Button
            type="submit"
            formAction={discardAction}
            variant="danger"
            disabled={isDiscarding || selectedCount === 0}
          >
            {isDiscarding ? "Descartando…" : `Descartar ${selectedCount || ""}`.trim()}
          </Button>
        </div>

        {orderState.error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {orderState.error}
          </p>
        ) : null}
        {orderState.ok ? (
          <p role="status" className="text-sm font-medium text-success">
            Marcados como pedidos. Salieron de la cola y quedan en «Ya pedidos».
          </p>
        ) : null}

        {discardState.error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {discardState.error}
          </p>
        ) : null}
        {discardState.ok ? (
          <p role="status" className="text-sm font-medium text-success">
            Faltantes descartados.
          </p>
        ) : null}
      </form>

      {children}
    </div>
  );
}
