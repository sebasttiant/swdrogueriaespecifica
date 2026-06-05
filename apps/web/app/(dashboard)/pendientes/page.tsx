import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card } from "@/app/_components/ui/card";

export const metadata: Metadata = { title: "Pendientes" };

export default function PendientesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Pendientes"
        description="Solicitudes de clientes. Genera faltantes cuando no hay stock (Fase 2)."
      />
      <Card>
        <p className="text-base text-muted-foreground">
          Módulo en construcción. Registro rápido de pendientes con estados:
          Pendiente, Parcial, Entregado, Cancelado.
        </p>
      </Card>
    </div>
  );
}
