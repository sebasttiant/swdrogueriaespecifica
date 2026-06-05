import type { Metadata } from "next";
import { CalendarRange, User, Activity, Layers, Boxes, CheckCircle2 } from "lucide-react";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";

export const metadata: Metadata = { title: "Auditoría" };

// Filtros futuros del módulo de auditoría (líderes / admin).
const FILTERS = [
  { label: "Fecha inicial / final", icon: CalendarRange },
  { label: "Usuario", icon: User },
  { label: "Acción", icon: Activity },
  { label: "Módulo", icon: Layers },
  { label: "Entidad", icon: Boxes },
  { label: "Resultado (exitoso / fallido)", icon: CheckCircle2 },
];

export default function AuditoriaPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Auditoría"
        description="Quién, cuándo, qué, sobre qué registro, qué cambió, desde dónde y si fue exitoso."
      />

      <Card className="space-y-3">
        <CardTitle>Consulta de auditoría (Fase 2)</CardTitle>
        <p className="text-base text-muted-foreground">
          La base ya está lista: modelo <code>AuditLog</code>, servicio
          reutilizable y acciones canónicas. Acá los líderes podrán filtrar por:
        </p>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {FILTERS.map((filter) => {
            const Icon = filter.icon;
            return (
              <li
                key={filter.label}
                className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm text-text"
              >
                <Icon className="size-4 shrink-0 text-primary" aria-hidden />
                {filter.label}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
