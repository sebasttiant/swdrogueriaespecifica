"use client";

import { useId, useState } from "react";
import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
import {
  resolvePendingIdentityAction,
  type ResolvePendingIdentityState,
} from "@/server/actions/pending.actions";

const INITIAL_STATE: ResolvePendingIdentityState = { error: null, ok: false };

type PendingIdentityResolveFormProps = {
  productId: string;
  identityVersion: number;
};

// --------------------------------------------------------------------------
// Formulario para resolver un producto de la cola de identidad pendiente.
//
// Muy similar a `OrionLinkForm` pero usa `resolvePendingIdentityAction` (gate
// con `canFixProductIdentity`) en vez de `linkOrionCodeAction` (gate con
// `canManageProducts`). La cola la lee quien puede resolverla, y el
// formulario respeta esa misma capacidad.
//
// El `identityVersion` viaja como hidden input para el compare-and-set: si
// otro operador vinculó primero, el servidor rechaza la escritura y el
// formulario muestra "refrescá", no "corregí".
// --------------------------------------------------------------------------
export function PendingIdentityResolveForm({
  productId,
  identityVersion,
}: PendingIdentityResolveFormProps) {
  const [orionCode, setOrionCode] = useState("");
  const [state, formAction, isPending] = useActionState(async (
    prev: ResolvePendingIdentityState,
    formData: FormData,
  ) => {
    const next = await resolvePendingIdentityAction(prev, formData);
    if (next.ok) setOrionCode("");
    return next;
  }, INITIAL_STATE);
  const inputId = useId();

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="expectedVersion" value={identityVersion} />

      <label htmlFor={inputId} className="text-sm font-medium text-text">
        Código de Orion
      </label>
      <div className="flex items-start gap-2">
        <Input
          id={inputId}
          name="orionCode"
          value={orionCode}
          onChange={(event) => setOrionCode(event.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={80}
          required
          disabled={isPending}
          placeholder="Pegalo desde Orion"
        />
        <Button type="submit" className="shrink-0" disabled={isPending}>
          {isPending ? "Vinculando…" : "Vincular"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Copialo exacto desde Orion. Si queda mal, se puede corregir, pero queda registrado.
      </p>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          Código vinculado. El producto ya no aparece en la cola.
        </p>
      ) : null}
    </form>
  );
}
