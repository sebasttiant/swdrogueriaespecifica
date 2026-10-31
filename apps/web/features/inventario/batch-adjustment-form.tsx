"use client";

import { useId, useState } from "react";
import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import {
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABELS,
  type AdjustmentReason,
} from "@/features/inventario/adjustment-reason";
import {
  adjustBatchQuantityAction,
  type InventoryAdjustmentFormState,
} from "@/server/actions/inventory-adjustment.actions";

const INITIAL_STATE: InventoryAdjustmentFormState = { error: null, ok: false };

type BatchAdjustmentFormProps = {
  productId: string;
  batchId: string;
  /** Cantidad que la pantalla está mostrando. Solo para orientar el conteo. */
  currentQuantity: number;
};

// --------------------------------------------------------------------------
// Corregir el stock de UN lote.
//
// Arranca plegado: ajustar no es la tarea cotidiana de la ficha del producto.
// Un formulario siempre abierto al lado de cada lote invita a tocarlo sin
// querer, y acá el costo lo paga el inventario.
//
// La cantidad que se pide es la FINAL (lo que el conteo encontró), no un delta.
// El servicio calcula el cambio DESPUÉS de trabar la fila, así un ajuste
// concurrente no aplica un delta viejo.
// --------------------------------------------------------------------------
export function BatchAdjustmentForm({
  productId,
  batchId,
  currentQuantity,
}: BatchAdjustmentFormProps) {
  const [state, formAction, isPending] = useActionState(
    adjustBatchQuantityAction,
    INITIAL_STATE,
  );
  const [open, setOpen] = useState(false);
  const [targetQuantity, setTargetQuantity] = useState(String(currentQuantity));
  const [reason, setReason] = useState<AdjustmentReason | "">("");
  const [note, setNote] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const quantityId = useId();
  const reasonId = useId();
  const noteId = useId();

  if (!open) {
    return (
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        Ajustar cantidad
      </Button>
    );
  }

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 border-t border-border pt-3"
    >
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <p className="text-sm text-muted-foreground">
        Cantidad en sistema:{" "}
        <span className="font-semibold text-text">{currentQuantity}</span>
      </p>

      <Field
        label="Cantidad contada"
        htmlFor={quantityId}
        hint="Lo que hay físicamente en el lote, no la diferencia."
      >
        <Input
          id={quantityId}
          name="targetQuantity"
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          required
          disabled={isPending}
          value={targetQuantity}
          onChange={(event) => {
            setTargetQuantity(event.target.value);
          }}
        />
      </Field>

      <Field label="Motivo" htmlFor={reasonId}>
        <Select
          id={reasonId}
          name="reason"
          required
          disabled={isPending}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value as AdjustmentReason | "");
          }}
        >
          <option value="" disabled>
            Elegí un motivo
          </option>
          {ADJUSTMENT_REASONS.map((value) => (
            <option key={value} value={value}>
              {ADJUSTMENT_REASON_LABELS[value]}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Nota (opcional)"
        htmlFor={noteId}
        hint="Detalle libre. El motivo estructurado ya quedó arriba."
      >
        <Input
          id={noteId}
          name="note"
          maxLength={500}
          disabled={isPending}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={isPending || reason === ""}>
          {isPending ? "Guardando…" : "Guardar ajuste"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancelar
        </Button>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          Ajuste guardado. Quedó registrado quién lo hizo y el antes/después.
        </p>
      ) : null}
    </form>
  );
}
