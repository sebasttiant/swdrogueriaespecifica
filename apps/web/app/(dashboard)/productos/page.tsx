import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card } from "@/app/_components/ui/card";

export const metadata: Metadata = { title: "Productos" };

export default function ProductosPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Productos"
        description="Catálogo, stock mínimo y reorden. Lógica en Fase 2."
      />
      <Card>
        <p className="text-base text-muted-foreground">
          Módulo en construcción. En celular se mostrará como lista de tarjetas
          (no tablas), con búsqueda simple y acciones grandes.
        </p>
      </Card>
    </div>
  );
}
