import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

type PageHeaderProps = {
  title: string;
  description?: string;
  // Acciones a la derecha (ej: botón "Nuevo"). Opcional.
  actions?: ReactNode;
  className?: string;
};

// Encabezado de página reutilizable. Mobile-first: en celular el título y las
// acciones se apilan; en pantallas anchas van en una fila.
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-text">{title}</h1>
        {description ? (
          <p className="mt-1 text-base text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
