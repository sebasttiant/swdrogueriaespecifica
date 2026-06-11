import Link from "next/link";

import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import type { AuditResultValue } from "@/features/auditoria/types";

type AuditFilterBarProps = {
  action?: string;
  module?: string;
  result?: AuditResultValue;
  userText?: string;
  from?: string;
  to?: string;
};

// Server component — no client state needed. Pre-fills controls from current
// searchParams via defaultValue. Submitting resets pagination (no cursor field).
// "Limpiar filtros" is a plain Link to /auditoria (removes all params).
export function AuditFilterBar({
  action,
  module,
  result,
  userText,
  from,
  to,
}: AuditFilterBarProps) {
  return (
    <form method="GET" action="/auditoria" className="rounded-lg border border-border bg-card p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {/* User / email free-text */}
        <Field label="Usuario o email" htmlFor="af-userText">
          <Input
            id="af-userText"
            name="userText"
            type="text"
            placeholder="Nombre o email..."
            defaultValue={userText ?? ""}
          />
        </Field>

        {/* Action select */}
        <Field label="Acción" htmlFor="af-action">
          <Select id="af-action" name="action" defaultValue={action ?? ""}>
            <option value="">Todas las acciones</option>
            {Object.entries(AUDIT_ACTIONS).map(([, value]) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>

        {/* Module select */}
        <Field label="Módulo" htmlFor="af-module">
          <Select id="af-module" name="module" defaultValue={module ?? ""}>
            <option value="">Todos los módulos</option>
            {Object.entries(AUDIT_MODULES).map(([, value]) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>

        {/* Result select */}
        <Field label="Resultado" htmlFor="af-result">
          <Select id="af-result" name="result" defaultValue={result ?? ""}>
            <option value="">Todos los resultados</option>
            <option value="SUCCESS">Exitoso</option>
            <option value="FAILURE">Fallido</option>
          </Select>
        </Field>

        {/* Date from */}
        <Field label="Desde" htmlFor="af-from">
          <Input
            id="af-from"
            name="from"
            type="date"
            defaultValue={from ?? ""}
          />
        </Field>

        {/* Date to */}
        <Field label="Hasta" htmlFor="af-to">
          <Input
            id="af-to"
            name="to"
            type="date"
            defaultValue={to ?? ""}
          />
        </Field>
      </div>

      {/* Actions row */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="min-h-11 rounded-[var(--radius-btn)] bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Filtrar
        </button>
        <Link
          href="/auditoria"
          className="min-h-11 inline-flex items-center rounded-[var(--radius-btn)] border border-border px-5 text-sm font-semibold text-muted-foreground hover:bg-muted/40"
        >
          Limpiar filtros
        </Link>
      </div>
    </form>
  );
}
