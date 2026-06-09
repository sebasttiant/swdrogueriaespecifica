"use client";

import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

// Pendientes error boundary — required Client Component (Next.js App Router).
export default function PendientesError({ reset }: ErrorProps) {
  return (
    <Card className="space-y-4 text-center">
      <p className="text-base font-semibold text-text">
        No se pudo cargar los pendientes.
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
