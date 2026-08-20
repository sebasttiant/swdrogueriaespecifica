"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
import {
  discardMissingItemsAction,
  markMissingItemsOrderedAction,
  type MissingItemActionState,
} from "@/server/actions/missing-item.actions";

const INITIAL_STATE: MissingItemActionState = { error: null, ok: false };

export type BulkSelectableItem = {
  id: string;
  productName: string;
  quantity: number | null;
  unit: string;
  sellerCode: string | null;
};

type MissingBulkActionsProps = {
  // Solo los faltantes que la acción admite (abiertos, sin pedido). Filtrar acá
  // evitaría ofrecer una casilla que el servidor va a rechazar igual.
  items: BulkSelectableItem[];
};

/**
 * Selección múltiple sobre la cola. Resuelve literalmente lo que pidió el
 * gerente: "no, okay, borrame del uno al 80".
 *
 * Ofrece las DOS salidas, en formularios separados y con textos opuestos:
 *
 *   ✓ Marcar como pedido → gerencia ya lo compró; la mercadería viene en camino.
 *   ✗ Descartar          → nadie lo va a pedir (duplicado o ya no hace falta).
 *
 * Siguen siendo dos acciones distintas, nunca un "OK" ambiguo: esa ambigüedad
 * es la que ya hubo que revertir una vez. Antes acá solo vivía el descarte
 * porque pedir exigía proveedor y cantidad; con el pedido rápido esa exigencia
 * desapareció y la simetría es posible.
 *
 * La página monta esto solo para la autoridad de compras; ambas Server Actions
 * revalidan la capacidad del lado del servidor de todas formas.
 */
export function MissingBulkActions({ items }: MissingBulkActionsProps) {
  const [orderState, orderAction, isOrdering] = useActionState(
    markMissingItemsOrderedAction,
    INITIAL_STATE,
  );
  const [state, formAction, isPending] = useActionState(
    discardMissingItemsAction,
    INITIAL_STATE,
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const reasonId = useId();

  if (items.length === 0) return null;

  const allSelected = selected.size === items.length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      // `delete` devuelve si existía: evita releer el set para decidir la rama.
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((current) =>
      current.size === items.length ? new Set() : new Set(items.map((item) => item.id)),
    );
  }

  const selectedIds = [...selected];

  // Los ids viajan como hidden en CADA formulario: las casillas viven fuera de
  // ambos para que una sola selección alimente las dos acciones.
  const selectionFields = selectedIds.map((id) => (
    <input key={id} type="hidden" name="ids" value={id} />
  ));

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-text">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="h-4 w-4 rounded border-border accent-primary"
          />
          Seleccionar todos ({items.length})
        </label>
        {selected.size > 0 ? (
          <span className="text-sm text-muted-foreground">
            {selected.size} seleccionado{selected.size === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {/* Una casilla por faltante. `min-h-11` en la fila entera: el objetivo
          táctil es la fila, no el cuadradito, porque el 90% del uso es celular. */}
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id}>
            <label className="flex min-h-11 items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                value={item.id}
                checked={selected.has(item.id)}
                onChange={() => toggle(item.id)}
                className="h-4 w-4 shrink-0 rounded border-border accent-primary"
              />
              <span className="min-w-0 break-words">
                {item.productName}
                <span className="ml-1 text-muted-foreground">
                  {item.sellerCode ?? (item.quantity === null ? "—" : `${item.quantity} ${item.unit}`)}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      {/* Acción principal: "ya los pedí". Es la que el gerente usa decenas de
          veces por día, así que va primero y no pide ningún dato más. */}
      <form action={orderAction}>
        {selectionFields}
        <Button type="submit" disabled={isOrdering || selected.size === 0}>
          {isOrdering
            ? "Marcando…"
            : `Marcar como pedido ${selected.size || ""}`.trim()}
        </Button>
      </form>

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

      {/* Descarte: el motivo vive en ESTE formulario, no en el de pedido, donde
          no significaría nada. */}
      <form action={formAction} className="space-y-3 border-t border-border pt-3">
        {selectionFields}
        <div className="space-y-1.5">
          <label htmlFor={reasonId} className="text-sm font-medium text-text">
            Motivo (opcional)
          </label>
          {/* Queda guardado: "por qué se descartó" es justo lo que alguien va a
              preguntar cuando el faltante desaparezca de la cola. */}
          <Input
            id={reasonId}
            name="reason"
            maxLength={200}
            placeholder="Duplicado, ya no se necesita…"
          />
        </div>

        <Button type="submit" variant="danger" disabled={isPending || selected.size === 0}>
          {isPending ? "Descartando…" : `Descartar ${selected.size || ""}`.trim()}
        </Button>
      </form>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          Faltantes descartados.
        </p>
      ) : null}
    </div>
  );
}
