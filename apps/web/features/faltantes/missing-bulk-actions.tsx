"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
import {
  discardMissingItemsAction,
  type MissingItemActionState,
} from "@/server/actions/missing-item.actions";

const INITIAL_STATE: MissingItemActionState = { error: null, ok: false };

export type BulkSelectableItem = {
  id: string;
  productName: string;
  quantity: number;
  unit: string;
};

type MissingBulkActionsProps = {
  // Solo los faltantes que la acción admite (abiertos, sin pedido). Filtrar acá
  // evitaría ofrecer una casilla que el servidor va a rechazar igual.
  items: BulkSelectableItem[];
};

/**
 * Selección múltiple para cerrar de una vez los faltantes que no representan
 * trabajo: los que un segundo vendedor anotó por duplicado, o los que ya no
 * hacen falta.
 *
 * Este componente solo ofrece DESCARTAR. Marcar como pedido vive en el
 * formulario "Pedir" de cada fila, porque exige proveedor y cantidad reales:
 * un botón masivo que dijera "OK" para ambas cosas es exactamente la
 * ambigüedad que ya hubo que revertir una vez.
 *
 * La página monta esto solo para la autoridad de compras; la Server Action
 * revalida la capacidad del lado del servidor de todas formas.
 */
export function MissingBulkActions({ items }: MissingBulkActionsProps) {
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

  return (
    <form action={formAction} className="space-y-3 rounded-lg border border-border p-3">
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
                name="ids"
                value={item.id}
                checked={selected.has(item.id)}
                onChange={() => toggle(item.id)}
                className="h-4 w-4 shrink-0 rounded border-border accent-primary"
              />
              <span className="min-w-0 truncate">
                {item.productName}
                <span className="ml-1 text-muted-foreground">
                  {item.quantity} {item.unit}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

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
    </form>
  );
}
