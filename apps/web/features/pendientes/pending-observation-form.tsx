"use client";

import { useState } from "react";
import { MessageSquarePlus, MessageSquareText } from "lucide-react";

import { useActionState } from "@/lib/hooks/use-action-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import { cn } from "@/lib/utils/cn";
import {
  updatePendingObservationAction,
  type PendingFormState,
} from "@/server/actions/pending.actions";
import {
  MANAGEMENT_OBSERVATION_MAX_LENGTH,
  managementObservationSummary,
} from "./management-observation";

const INITIAL_STATE: PendingFormState = { error: null, ok: false };

type PendingObservationFormProps = {
  pendingId: string;
  observation: string | null;
  version: number;
  observedAt: Date | null;
  observedByName: string | null;
  // Cosmético: la Server Action vuelve a comprobar la capability siempre. Un
  // vendedor con esto en `false` sigue LEYENDO la observación — es para él.
  canWrite: boolean;
  // Desambigua los `id` del DOM cuando la MISMA fila se pinta dos veces —la
  // tarjeta del celular y la tabla del escritorio—. Sin esto las dos instancias
  // comparten el `id` del textarea, y `htmlFor` ata la etiqueta a la primera:
  // en el escritorio el rótulo quedaría apuntando al campo invisible.
  domSuffix?: string;
};

// --------------------------------------------------------------------------
// La observación de gerencia dentro de la fila.
//
// No es un modal. El repo ya resuelve "acción secundaria que no roba lugar" con
// `<details>` —el mismo gesto del estado de gestión—, y un modal traería justo
// los problemas que este pedido quería evitar: teclado del celular tapando el
// campo, viewport que no alcanza, foco que se escapa.
//
// Sin observación y sin permiso de escritura NO renderiza nada: una fila vacía
// no puede pagar el alto de un bloque que no dice nada.
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// La observación, para leer. SIN hooks a propósito.
//
// Es lo que ve el vendedor, que es la mayoría de las filas y de las miradas.
// Mantenerla libre de hooks la deja renderizable en estático y hace que una
// fila sin permiso de escritura no monte un cliente para no mostrar nada.
// --------------------------------------------------------------------------
export function PendingObservationView({
  observation,
  observedAt,
  observedByName,
}: Pick<
  PendingObservationFormProps,
  "observation" | "observedAt" | "observedByName"
>) {
  const summary = managementObservationSummary(observation);
  if (!summary) return null;

  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
      <p className="[overflow-wrap:anywhere] text-sm text-text">
        <span className="font-semibold">Gerencia:</span> {summary}
      </p>
      {/* El resumen recorta; el texto completo nunca queda fuera de alcance.
          Sin hover: en el celular no existe. */}
      {observation && summary !== observation.replace(/\n+/g, " · ") ? (
        <details className="mt-1">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-xs text-muted-foreground underline hover:text-text [&::-webkit-details-marker]:hidden">
            Ver completa
          </summary>
          <p className="mt-1 whitespace-pre-line [overflow-wrap:anywhere] text-sm text-text">
            {observation}
          </p>
        </details>
      ) : null}
      {observedAt ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {observedByName ? `${observedByName} · ` : ""}
          {formatBogotaDate(observedAt, { style: "datetime" })}
        </p>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------
// El gesto de escritura. Se monta SOLO cuando quien mira puede escribir: los
// hooks corren en cuanto el componente existe, así que la decisión vive en
// quien lo llama y no en un `return null` tardío que igual los ejecutaría.
// --------------------------------------------------------------------------
export function PendingObservationForm({
  pendingId,
  observation,
  version,
  observedAt,
  observedByName,
  domSuffix = "",
}: Omit<PendingObservationFormProps, "canWrite">) {
  const [state, formAction, isPending] = useActionState(
    updatePendingObservationAction,
    INITIAL_STATE,
  );
  // El texto tipeado vive acá para que un guardado fallido no se lo lleve: el
  // borrador es de quien lo escribió, no del resultado del servidor.
  const [draft, setDraft] = useState(() => observation ?? "");

  const summary = managementObservationSummary(observation);
  const fieldId = `observation-${pendingId}${domSuffix ? `-${domSuffix}` : ""}`;
  const remaining = MANAGEMENT_OBSERVATION_MAX_LENGTH - draft.trim().length;

  return (
    <div className="space-y-1.5">
      <PendingObservationView
        observation={observation}
        observedAt={observedAt}
        observedByName={observedByName}
      />

      <details className="group">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground hover:text-text [&::-webkit-details-marker]:hidden">
            {summary ? (
              <MessageSquareText className="size-4" aria-hidden />
            ) : (
              <MessageSquarePlus className="size-4" aria-hidden />
            )}
            <span className="underline">
              {summary ? "Editar observación" : "Agregar observación"}
            </span>
          </summary>
          <form action={formAction} className="mt-2 space-y-1.5">
            <input type="hidden" name="id" value={pendingId} />
            {/* Compare-and-set: se escribe solo si la observación sigue siendo
                la que esta pantalla vio. Dos gerentes no se pisan. */}
            <input type="hidden" name="expectedVersion" value={version} />
            <label htmlFor={fieldId} className="sr-only">
              Observación de gerencia
            </label>
            <textarea
              id={fieldId}
              name="observation"
              rows={3}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={MANAGEMENT_OBSERVATION_MAX_LENGTH}
              placeholder="Lo que el vendedor tiene que saber de este pendiente"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={isPending}
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 px-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
              >
                {isPending ? "Guardando…" : "Guardar"}
              </button>
              {/* Vaciar el campo y guardar es cómo se borra. Decirlo evita que
                  alguien busque un botón "eliminar" que no existe. */}
              <span
                className={cn(
                  "text-xs",
                  remaining < 0 ? "font-semibold text-danger" : "text-muted-foreground",
                )}
              >
                {draft.trim().length === 0
                  ? "Guardar vacío borra la observación"
                  : `${remaining} caracteres`}
              </span>
            </div>
            {state.error ? (
              <p role="alert" className="text-xs font-medium text-danger">
                {state.error}
              </p>
            ) : null}
          </form>
      </details>
    </div>
  );
}
