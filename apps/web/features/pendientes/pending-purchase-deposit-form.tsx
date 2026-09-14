"use client";

import { useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { useActionState } from "@/lib/hooks/use-action-state";
import {
  updatePendingPurchaseDepositAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";
import { PURCHASE_DEPOSIT_MAX_LENGTH } from "./purchase-deposit";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

type PendingPurchaseDepositFormProps = {
  pendingId: string;
  deposit: string | null;
};

// --------------------------------------------------------------------------
// El depósito de compra dentro de la fila: dónde se pidió el producto.
//
// Se monta SOLO para quien tiene `canManagePurchaseDeposit`: la decisión vive
// en quien lo llama, igual que el formulario de la observación, y la Server
// Action vuelve a comprobar la capacidad siempre. Guardar vacío lo borra.
// --------------------------------------------------------------------------
export function PendingPurchaseDepositForm({
  pendingId,
  deposit,
}: PendingPurchaseDepositFormProps) {
  const [state, formAction, isPending] = useActionState(
    updatePendingPurchaseDepositAction,
    INITIAL_STATE,
  );
  // Controlado para que un guardado fallido no se lleve lo que se escribió.
  const [draft, setDraft] = useState(() => deposit ?? "");
  const fieldId = `purchase-deposit-${pendingId}`;

  return (
    <form action={formAction} className="space-y-1.5">
      <input type="hidden" name="id" value={pendingId} />
      <Field label="Depósito" htmlFor={fieldId} error={state.error ?? undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={fieldId}
            name="deposit"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={PURCHASE_DEPOSIT_MAX_LENGTH}
            placeholder="Ej.: N3"
            className="flex-1 basis-40"
          />
          <Button type="submit" variant="outline" disabled={isPending}>
            {isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </Field>
      {deposit ? (
        <p className="break-words text-xs text-muted-foreground">
          {`Guardado: ${deposit}`}
        </p>
      ) : null}
    </form>
  );
}
