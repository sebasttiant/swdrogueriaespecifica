import Link from "next/link";

import { cn } from "@/lib/utils/cn";

import {
  AVAILABILITY_AXIS_LABELS,
  AVAILABILITY_AXIS_VALUES,
  CUSTOMER_AXIS_LABELS,
  CUSTOMER_AXIS_VALUES,
  hasActiveAxis,
  PURCHASE_AXIS_LABELS,
  PURCHASE_AXIS_VALUES,
  reviewHref,
  type ReviewAxes,
} from "./review-axes";

// Filtros de revisión: tres ejes independientes, cada uno con su fila de
// opciones. Son enlaces (?purchase=…) y no un formulario con estado, igual que
// el resto de la pantalla: la página es server y se vuelve a renderizar con lo
// filtrado, así que funciona sin JavaScript y la vista queda en la URL —
// compartible y recargable sin perder lo que uno estaba mirando.
//
// NO hay selector de rol. Quién puede ver qué sale de la sesión y de las
// capacidades; un desplegable de rol en pantalla dejaría que cualquiera se
// asigne el suyo.

type PendingReviewFiltersProps = {
  axes: ReviewAxes;
  scope: "active" | "history";
  view: "lista" | "detalle";
  // Ruta sobre la que se arman los enlaces. Se omite en `/pendientes`, que es
  // el default; el módulo de revisión pasa la suya para no expulsar al usuario.
  basePath?: string;
};

export function PendingReviewFilters({
  axes,
  scope,
  view,
  basePath,
}: PendingReviewFiltersProps) {
  return (
    <section aria-label="Filtros de revisión" className="space-y-3">
      <AxisRow
        legend="Compras"
        values={PURCHASE_AXIS_VALUES}
        labels={PURCHASE_AXIS_LABELS}
        active={axes.purchase}
        hrefFor={(value) => reviewHref({ scope, view, basePath, axes: { ...axes, purchase: value } })}
      />
      <AxisRow
        legend="Disponibilidad"
        values={AVAILABILITY_AXIS_VALUES}
        labels={AVAILABILITY_AXIS_LABELS}
        active={axes.availability}
        hrefFor={(value) => reviewHref({ scope, view, basePath, axes: { ...axes, availability: value } })}
      />
      <AxisRow
        legend="Cliente"
        values={CUSTOMER_AXIS_VALUES}
        labels={CUSTOMER_AXIS_LABELS}
        active={axes.customer}
        hrefFor={(value) => reviewHref({ scope, view, basePath, axes: { ...axes, customer: value } })}
      />

      {/* Salida visible: con tres ejes es fácil terminar en una lista vacía sin
          entender por qué. El atajo para volver a verlo todo tiene que estar a
          la vista, no depender de que alguien edite la URL. */}
      {hasActiveAxis(axes) ? (
        <Link prefetch={false}
          href={reviewHref({ scope, view, basePath, axes: {} })}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-4"
        >
          Quitar filtros
        </Link>
      ) : null}
    </section>
  );
}

type AxisRowProps<T extends string> = {
  legend: string;
  values: readonly T[];
  labels: Record<T, string>;
  active: T | undefined;
  hrefFor: (value: T | undefined) => string;
};

function AxisRow<T extends string>({
  legend,
  values,
  labels,
  active,
  hrefFor,
}: AxisRowProps<T>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-28 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {legend}
      </span>

      {/* "Todos" es un valor más del eje, no un botón aparte: apagarlo es
          elegirlo, y así el eje siempre tiene exactamente una opción activa. */}
      <FilterLink href={hrefFor(undefined)} isActive={active === undefined}>
        Todos
      </FilterLink>

      {values.map((value) => (
        <FilterLink key={value} href={hrefFor(value)} isActive={active === value}>
          {labels[value]}
        </FilterLink>
      ))}
    </div>
  );
}

function FilterLink({
  href,
  isActive,
  children,
}: {
  href: string;
  isActive: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link prefetch={false}
      href={href}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        // min-h-11: objetivo táctil cómodo en el celular del mostrador.
        "inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium transition-colors",
        isActive
          ? "bg-primary text-primary-foreground"
          : "bg-muted/60 text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </Link>
  );
}
