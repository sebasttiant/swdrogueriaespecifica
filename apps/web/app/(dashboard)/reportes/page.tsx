import type { Metadata } from "next";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card } from "@/app/_components/ui/card";

export const metadata: Metadata = { title: "Reportes" };

export default function ReportesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reportes"
        description="Estado de la operación y exportación CSV para líderes (Fase 2)."
      />
      <Card>
        <p className="text-base text-muted-foreground">
          Módulo en construcción. Incluirá exportación CSV y reportería de
          estado de la operación.
        </p>
      </Card>
    </div>
  );
}
