"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
import {
  fixOrionCodeAction,
  type OrionLinkFormState,
} from "@/server/actions/sku.actions";

const INITIAL_STATE: OrionLinkFormState = { error: null, ok: false };

type OrionFixFormProps = {
  productId: string;
  /** El código que hoy tiene el producto: el que se está por reemplazar. */
  currentOrionCode: string;
  /** La versión de identidad que ESTA pantalla está mostrando. */
  identityVersion: number;
};

// --------------------------------------------------------------------------
// Corregir un código de Orion mal cargado.
//
// Arranca PLEGADO, detrás de un botón. Corregir identidad no es una tarea
// cotidiana: es la excepción. Un campo de texto siempre abierto al lado de un
// código correcto invita a tocarlo, y acá el costo de tocarlo sin querer lo
// paga el inventario.
//
// `identityVersion` viaja escondido por la misma razón que en el vínculo: el
// servidor solo escribe si la versión sigue siendo la vigente. Si otro corrigió
// mientras tanto, esta pantalla está mirando el pasado y la escritura se
// rechaza en vez de pisar lo que hizo el otro.
// --------------------------------------------------------------------------
export function OrionFixForm({
  productId,
  currentOrionCode,
  identityVersion,
}: OrionFixFormProps) {
  const [state, formAction, isPending] = useActionState(fixOrionCodeAction, INITIAL_STATE);
  const [open, setOpen] = useState(false);
  const [orionCode, setOrionCode] = useState("");
  const inputId = useId();

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => { setOpen(true); }}>
        Corregir el código
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2 border-t border-border pt-3">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="expectedVersion" value={identityVersion} />

      <label htmlFor={inputId} className="text-sm font-medium text-text">
        Código correcto de Orion
      </label>
      <div className="flex items-start gap-2">
        <Input
          id={inputId}
          name="orionCode"
          value={orionCode}
          onChange={(event) => setOrionCode(event.target.value)}
          // Sin ayuda del teclado: se copia y pega desde Orion tal cual, y
          // cualquier autocorrección acá sería un error de datos.
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={80}
          required
          disabled={isPending}
          placeholder="Pegalo desde Orion"
        />
        <Button type="submit" className="shrink-0" disabled={isPending}>
          {isPending ? "Corrigiendo…" : "Guardar"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Reemplaza a <span className="font-mono">{currentOrionCode}</span>. Queda
        registrado quién lo cambió y de qué código se venía.
      </p>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm font-medium text-success">
          Código corregido.
        </p>
      ) : null}
    </form>
  );
}
