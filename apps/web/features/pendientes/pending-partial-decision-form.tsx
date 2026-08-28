"use client";

import { useActionState } from "@/lib/hooks/use-action-state";
import { Clock, Link2, PackageCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  resolvePartialPendingAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";
import { cn } from "@/lib/utils/cn";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

type PendingPartialDecisionFormProps = {
  pendingId: string;
  /** Lo que quedó sin entregar. Es el número sobre el que decide el cliente. */
  remaining: number;
};

// --------------------------------------------------------------------------
// Qué hace el cliente con lo que faltó.
//
// Llegaron 3 de 5, el vendedor le entrega los 3 y le pregunta. Hay exactamente
// tres respuestas, y las tres ya existían en la operación —dos de ellas son
// literalmente las notas que el vendedor escribe hoy en su tabla:
//
//   "Cliente espera"    → aguarda el resto; el pendiente sigue vivo
//   "Va con otro pedido" → se lo juntan con otro; el pendiente sigue vivo
//   "No los espera"      → se cierra con lo entregado
//
// La CANTIDAD ya la decidió en la entrega. Acá solo se responde qué pasa con el
// resto. Sin esta pregunta un parcial quedaba abierto para siempre, y la cola de
// todos se llenaba de cosas ya resueltas en el mostrador.
// --------------------------------------------------------------------------

const DECISIONS: { value: string; label: string; icon: LucideIcon; tone: "wait" | "close" }[] = [
  { value: "espera", label: "Espera el resto", icon: Clock, tone: "wait" },
  { value: "va_con_pedido", label: "Va con otro pedido", icon: Link2, tone: "wait" },
  { value: "cerrar", label: "No los espera", icon: PackageCheck, tone: "close" },
];

const BUTTON_BASE =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors disabled:opacity-50";

const TONE = {
  wait: "border-border bg-muted/40 text-text hover:bg-muted",
  close: "border-success/30 bg-success/10 text-success hover:bg-success/20",
} as const;

export function PendingPartialDecisionForm({
  pendingId,
  remaining,
}: PendingPartialDecisionFormProps) {
  const [state, action, pending] = useActionState(
    resolvePartialPendingAction,
    INITIAL_STATE,
  );

  return (
    <form action={action} className="w-full space-y-2 rounded-lg bg-muted/30 p-2">
      <input type="hidden" name="id" value={pendingId} />
      <p className="text-xs font-medium text-muted-foreground">
        Faltan {remaining}. ¿Qué hace el cliente?
      </p>
      <div className="flex flex-wrap gap-2">
        {DECISIONS.map(({ value, label, icon: Icon, tone }) => (
          <button
            key={value}
            type="submit"
            name="decision"
            value={value}
            disabled={pending}
            className={cn(BUTTON_BASE, TONE[tone])}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      {state.error ? (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
