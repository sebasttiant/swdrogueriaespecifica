import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card } from "@/app/_components/ui/card";

export const metadata: Metadata = { title: "Entradas" };

export default function EntradasPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Entradas de inventario"
        description="Aumentan stock y cierran faltantes abiertos (Fase 2)."
      />
      <Card>
        <p className="text-base text-muted-foreground">
          Módulo en construcción. Al registrar una entrada se actualizará el
          stock y se reducirán o cerrarán los faltantes correspondientes.
        </p>
      </Card>
    </div>
  );
}
