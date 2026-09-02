import Link from "next/link";

import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { USER_ROLES } from "@/lib/auth/permissions";

import {
  adminPageHref,
  hasActiveFilters,
  USER_STATUS_FILTERS,
  type UserFilters as Filters,
} from "./filters";
import { ROLE_LABELS } from "./schema";

// --------------------------------------------------------------------------
// La barra de búsqueda y filtros de Administración.
//
// Es un formulario GET, sin JavaScript de por medio: el navegador arma la URL
// con los campos que tienen `name`, y esa URL es exactamente el contrato que el
// servidor ya sabe leer. No hay una segunda interpretación de los parámetros y
// no se filtra nada en el cliente.
//
// El `cursor` NO viaja en el formulario, y esa ausencia es la regla: cambiar un
// filtro cambia el conjunto de resultados, y una posición dentro del conjunto
// anterior no significa nada en el nuevo.
// --------------------------------------------------------------------------

const STATUS_LABELS: Record<(typeof USER_STATUS_FILTERS)[number], string> = {
  activos: "Activos",
  inactivos: "Inactivos",
};

type UserFiltersProps = {
  /** Los filtros que la pantalla está mostrando ahora. */
  filters: Filters;
  /** Solo SUPERADMIN alterna a la vista archivada. */
  canSeeArchived: boolean;
};

export function UserFilters({ filters, canSeeArchived }: UserFiltersProps) {
  const conFiltros = hasActiveFilters(filters);

  return (
    <Card className="space-y-4">
      <form method="get" action="/admin" className="space-y-4">
        {/* La vista viaja como campo oculto: al filtrar dentro de archivados,
            se sigue filtrando dentro de archivados. */}
        {filters.archived ? (
          <input type="hidden" name="archived" value="true" />
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="Buscar por nombre o correo"
            htmlFor="q"
            className="sm:col-span-2"
          >
            <Input
              id="q"
              name="q"
              type="search"
              defaultValue={filters.q ?? ""}
              placeholder="Ej: Ana, ana@…"
              autoComplete="off"
            />
          </Field>

          <Field label="Rol" htmlFor="role">
            <Select id="role" name="role" defaultValue={filters.role ?? ""}>
              <option value="">Todos los roles</option>
              {USER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          </Field>

          {/* Dentro de archivados no se ofrece: todo archivado está inactivo,
              así que el control prometería resultados que no pueden existir. */}
          {filters.archived ? null : (
            <Field label="Estado" htmlFor="status">
              <Select id="status" name="status" defaultValue={filters.status ?? ""}>
                <option value="">Todos los estados</option>
                {USER_STATUS_FILTERS.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit">Filtrar</Button>

          {conFiltros ? (
            <Link
              prefetch={false}
              href={adminPageHref(
                { archived: filters.archived },
                { archived: filters.archived },
              )}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-2 hover:underline"
            >
              Limpiar filtros
            </Link>
          ) : null}

          {canSeeArchived ? (
            <Link
              prefetch={false}
              href={adminPageHref(filters, { archived: !filters.archived })}
              className="ml-auto inline-flex min-h-11 items-center text-sm font-semibold text-muted-foreground underline-offset-2 hover:underline"
            >
              {filters.archived ? "Ver usuarios operativos" : "Ver archivados"}
            </Link>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
