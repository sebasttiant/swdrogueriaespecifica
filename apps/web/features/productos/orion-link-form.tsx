"use client";

import { useActionState, useId } from "react";

import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
import {
  linkOrionCodeAction,
  type OrionLinkFormState,
} from "@/server/actions/sku.actions";

const INITIAL_STATE: OrionLinkFormState = { error: null, ok: false };

type OrionLinkFormProps = {
  productId: string;
  /** La versión de identidad que ESTA pantalla está mostrando. */
  identityVersion: number;
};

// Vincular el producto con su código de Orion.
//
// `identityVersion` viaja escondido porque es el corazón del asunto: el
// servidor solo escribe si la versión que mandamos sigue siendo la vigente. Si
// otro operador vinculó primero, esta pantalla está mirando el pasado y la
// escritura se rechaza en vez de pisar lo que hizo el otro. Por eso el mensaje
// de esa falla dice "refrescá", no "corregí": no hay nada mal en lo que se
// escribió acá.
//
// El código NO se pasa a mayúsculas ni se limpia por dentro: la identidad es
// exacta, y "7702-A" y "7702-a" son dos productos distintos hasta que alguien
// de Orion diga lo contrario.
export function OrionLinkForm({ productId, identityVersion }: OrionLinkFormProps) {
  const [state, formAction, isPending] = useActionState(
    linkOrionCodeAction,
    INITIAL_STATE,
  );
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
          // Sin `autoCapitalize` ni corrección: se copia y pega desde Orion tal
          // cual, y cualquier ayuda del teclado acá sería un error de datos.
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
        Es lo que va a permitir cuadrar el inventario, así que copialo exacto.
        Si queda mal, se puede corregir, pero queda registrado.
      </p>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          Código vinculado.
        </p>
      ) : null}
    </form>
  );
}
