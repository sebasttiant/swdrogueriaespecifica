import { Skeleton } from "@/app/_components/ui/skeleton";

// Esqueleto de la revisión de pendientes: encabezado, los tres ejes de filtro y
// las filas. La ruta es `force-dynamic` y consulta la base en cada visita, así
// que sin esto navegar hasta acá deja la pantalla anterior clavada, sin señal
// de que algo está pasando.
export default function RevisionPendientesLoading() {
  return (
    <div className="space-y-4">
      {/* Encabezado */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>

      {/* Los tres ejes: compras, disponibilidad y cliente */}
      <div className="space-y-3">
        {[5, 4, 5].map((options, axis) => (
          <div key={axis} className="flex flex-wrap gap-2">
            {Array.from({ length: options }, (_, option) => (
              <Skeleton key={option} className="h-11 w-28" />
            ))}
          </div>
        ))}
      </div>

      {/* Filas */}
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}
