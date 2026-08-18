"use client";

import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

// Borde de error de la revisión de pendientes. Client Component obligatorio
// (App Router). Sin este archivo, un fallo al consultar se escapaba al borde
// del dashboard entero y se llevaba puesta la navegación con él.
export default function RevisionPendientesError({ reset }: ErrorProps) {
  return (
    <Card className="space-y-4 text-center">
      <p className="text-base font-semibold text-text">
        No se pudo cargar la revisión de pendientes.
      </p>
      <p className="text-sm text-muted-foreground">
        Ocurrió un problema al obtener los datos. Podés intentarlo nuevamente.
      </p>
      <Button variant="primary" onClick={reset}>
        Reintentar
      </Button>
    </Card>
  );
}
