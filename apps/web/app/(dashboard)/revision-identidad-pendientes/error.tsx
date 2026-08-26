"use client";

import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

// Borde local: conserva el resto del dashboard y no expone detalles internos.
export default function RevisionIdentidadPendientesError({ reset }: ErrorProps) {
  return (
    <Card className="space-y-4 text-center">
      <p className="text-base font-semibold text-text">
        No se pudo cargar la revisión de identidad.
      </p>
      <p className="text-sm text-muted-foreground">
        Ocurrió un problema al obtener los productos pendientes de vinculación. Podés intentarlo
        nuevamente.
      </p>
      <Button variant="primary" onClick={reset}>
        Reintentar
      </Button>
    </Card>
  );
}
