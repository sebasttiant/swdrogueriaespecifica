"use client";

import { Megaphone } from "lucide-react";
import { useId, useState } from "react";
import { useActionState } from "@/lib/hooks/use-action-state";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import {
  MAX_MISSING_REPORT_NAME_LENGTH,
  MAX_MISSING_REPORT_PRESENTATION_LENGTH,
  MAX_MISSING_REPORT_SELLER_CODE_LENGTH,
} from "@/features/faltantes/schema";
import { LaboratorySearch } from "@/features/productos/laboratory-search";
import {
  createMissingReportAction,
  type MissingReportActionState,
} from "@/server/actions/missing-report.actions";

const INITIAL_STATE: MissingReportActionState = { error: null, ok: false };

type MissingReportFormProps = { defaultOpen?: boolean };

// Reporte rápido de un vendedor desde el celular: el 90% del uso es móvil, así
// que el formulario nace COLAPSADO detrás de un botón compacto y de ancho
// completo (target táctil holgado, usable con una mano). Abierto, muestra el
// nombre pegado desde Orión y, debajo, lo que el vendedor PUEDA agregar.
// Cantidad, proveedor y producto canónico siguen siendo decisión de gerencia en
// otro flujo; acá no aparecen.
//
// UN SOLO CAMPO OBLIGATORIO, y sigue siendo el nombre. Presentación y
// laboratorio son opcionales de verdad: el vendedor está en el mostrador con un
// cliente adelante, y exigirle datos que a veces no conoce convierte un reporte
// de diez segundos en una fricción que termina en NO reportar. Un faltante sin
// laboratorio vale muchísimo más que un faltante que nadie cargó.
//
// El contrato con la Server Action es exactamente `rawName`. El `reporterId`
// SIEMPRE lo pone el servidor desde la sesión: no viaja en el formulario.
export function MissingReportForm({ defaultOpen = false }: MissingReportFormProps) {
  const [state, formAction, isPending] = useActionState(
    createMissingReportAction,
    INITIAL_STATE,
  );
  const [open, setOpen] = useState(defaultOpen);
  // Input CONTROLADO a propósito: un `<form action>` uncontrolled se resetea en
  // React 19 al terminar la acción TAMBIÉN en error, y borrar el nombre que el
  // vendedor acaba de pegar tras un rechazo lo obligaría a volver a copiarlo de
  // Orión. Controlado, se limpia SOLO en éxito y se conserva en error.
  const [rawName, setRawName] = useState("");
  const [sellerCode, setSellerCode] = useState("");
  const [presentation, setPresentation] = useState("");
  // El selector de laboratorio guarda su propio estado, así que no se limpia
  // solo. Cambiar su `key` lo REMONTA, que es la forma de React de decir
  // "empezá de cero" sin agregarle una API de reinicio que nadie más necesita.
  const [laboratoryKey, setLaboratoryKey] = useState(0);
  // Una vez que el vendedor edita el campo, el resultado anterior ya no lo
  // describe: se oculta para no dejar un "enviado" viejo sobre un reporte nuevo.
  const [dirty, setDirty] = useState(false);
  const rawNameId = useId();
  const sellerCodeId = useId();
  const presentationId = useId();

  // Ajuste de estado al cambiar `state`, DURANTE el render (patrón recomendado
  // por React, no un efecto): `state` es un objeto nuevo por cada envío, así que
  // al detectar uno distinto del último visto limpiamos el campo en éxito y
  // descartamos el estado "editando" para mostrar el feedback fresco. En error
  // el campo NO se toca: el nombre pegado se conserva.
  const [lastState, setLastState] = useState(state);
  if (state !== lastState) {
    setLastState(state);
    setDirty(false);
    if (state.ok) {
      setRawName("");
      setSellerCode("");
      setPresentation("");
      setLaboratoryKey((key) => key + 1);
    }
  }

  // El éxito/error viaja en `state` (useActionState) y sobrevive al colapso: el
  // vendedor ve la confirmación aunque el formulario ya se haya cerrado. Se
  // oculta apenas empieza a escribir el próximo reporte.
  const feedback =
    dirty ? null : state.error ? (
      <p role="alert" className="text-sm font-medium text-danger break-words">
        {state.error}
      </p>
    ) : state.ok ? (
      <p role="status" className="text-sm font-medium text-success break-words">
        Reporte enviado para revisión
      </p>
    ) : null;

  if (!open) {
    return (
      <div className="space-y-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="w-full"
        >
          <Megaphone aria-hidden="true" className="h-4 w-4" />
          Reportar faltante
        </Button>
        {feedback}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <Field
        label="Nombre del producto"
        htmlFor={rawNameId}
        hint="Pegá el nombre tal como aparece en Orión."
      >
        <Input
          id={rawNameId}
          name="rawName"
          value={rawName}
          onChange={(event) => {
            setRawName(event.target.value);
            setDirty(true);
          }}
          required
          maxLength={MAX_MISSING_REPORT_NAME_LENGTH}
          autoComplete="off"
          placeholder="Pegá el nombre desde Orión"
        />
      </Field>

      {/* Los dos opcionales van DESPUÉS del nombre: los tres describen el mismo
          producto. El código del vendedor queda último porque no habla del
          producto sino de quién reporta. */}
      <Field
        label="Presentación (opcional)"
        htmlFor={presentationId}
        hint="Frasco, caja, sobre, blíster… Si no la sabés, dejalo vacío."
      >
        <Input
          id={presentationId}
          name="presentation"
          value={presentation}
          onChange={(event) => {
            setPresentation(event.target.value);
            setDirty(true);
          }}
          maxLength={MAX_MISSING_REPORT_PRESENTATION_LENGTH}
          autoComplete="off"
          placeholder="Ej. caja x 30"
        />
      </Field>

      {/* El MISMO componente que usa el formulario de pendientes: dos pantallas
          que piden el mismo dato no pueden pedirlo de dos maneras distintas.
          Trae los laboratorios ya creados y permite agregar uno que falte,
          igual que allá. */}
      <LaboratorySearch
        key={laboratoryKey}
        name="requestedLaboratoryId"
        nameForLabel="requestedLaboratoryName"
        label="Laboratorio (opcional)"
        hint="Si no lo conocés, podés dejarlo vacío."
      />

      <Field
        label="Código del vendedor (opcional)"
        htmlFor={sellerCodeId}
        hint="Si tenés un código de vendedor, agregalo para gerencia."
      >
        <Input
          id={sellerCodeId}
          name="sellerCode"
          value={sellerCode}
          onChange={(event) => {
            setSellerCode(event.target.value);
            setDirty(true);
          }}
          maxLength={MAX_MISSING_REPORT_SELLER_CODE_LENGTH}
          autoComplete="off"
          placeholder="Ej. VEN-12"
        />
      </Field>

      {feedback}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={isPending}
          className="flex-1"
        >
          Cerrar
        </Button>
        <Button type="submit" variant="secondary" disabled={isPending} className="flex-1">
          <Megaphone aria-hidden="true" className="h-4 w-4" />
          {isPending ? "Enviando…" : "Enviar reporte"}
        </Button>
      </div>
    </form>
  );
}
