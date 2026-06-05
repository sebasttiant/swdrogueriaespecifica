import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card } from "@/app/_components/ui/card";

export const metadata: Metadata = { title: "Faltantes" };

export default function FaltantesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Faltantes"
        description="Lo que hay que conseguir. Estados: Faltante, Pedido, Recibido, Cancelado."
      />
      <Card>
        <p className="text-base text-muted-foreground">
          Módulo en construcción. Los faltantes pueden generarse automáticamente
          desde un pendiente sin stock suficiente (Fase 2).
        </p>
      </Card>
    </div>
  );
}
