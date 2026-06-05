import type { Metadata } from "next";
import {
  ClipboardList,
  PackageX,
  PackageMinus,
  CalendarClock,
  ClipboardPlus,
  PackagePlus,
  Search,
} from "lucide-react";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { KpiCard } from "@/app/_components/ui/kpi-card";
import { QuickAction } from "@/app/_components/ui/quick-action";
import { StatusPill } from "@/app/_components/ui/status-pill";

export const metadata: Metadata = { title: "Dashboard" };

// Placeholder de Fase 1: estructura visual lista, sin lógica real todavía.
// Los valores ("—") y la lista de urgencias se conectan a datos en fases siguientes.
export const dynamic = "force-dynamic";

function getGreeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return "Buenos días";
  if (hour < 19) return "Buenas tardes";
  return "Buenas noches";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function DashboardPage() {
  const now = new Date();
  const dateLabel = capitalize(
    new Intl.DateTimeFormat("es-CO", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(now),
  );

  return (
    <div className="space-y-6">
      <PageHeader title={`${getGreeting(now)} 👋`} description={dateLabel} />

      {/* Estado general de la operación */}
      <Card className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Estado general de la operación</CardTitle>
          <p className="text-sm text-muted-foreground">
            Resumen rápido del día (datos de ejemplo en Fase 1).
          </p>
        </div>
        <StatusPill tone="success" label="Operación normal" />
      </Card>

      {/* KPIs principales */}
      <section aria-label="Indicadores principales">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <KpiCard label="Pendientes abiertos" value="—" icon={ClipboardList} tone="primary" hint="Sin datos reales aún" />
          <KpiCard label="Faltantes urgentes" value="—" icon={PackageX} tone="danger" hint="Sin datos reales aún" />
          <KpiCard label="Productos bajo mínimo" value="—" icon={PackageMinus} tone="warning" hint="Sin datos reales aún" />
          <KpiCard label="Próximos vencimientos" value="—" icon={CalendarClock} tone="success" hint="Sin datos reales aún" />
        </div>
      </section>

      {/* Acciones rápidas */}
      <section aria-label="Acciones rápidas">
        <h2 className="mb-3 text-lg font-semibold text-text">Acciones rápidas</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <QuickAction label="Nuevo pendiente" href="/pendientes" icon={ClipboardPlus} />
          <QuickAction label="Nuevo faltante" href="/faltantes" icon={PackageX} />
          <QuickAction label="Nueva entrada" href="/entradas" icon={PackagePlus} />
          <QuickAction label="Buscar producto" href="/productos" icon={Search} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Urgencias (placeholder) */}
        <Card className="space-y-3">
          <CardTitle>Urgencias del día</CardTitle>
          <p className="text-sm text-muted-foreground">
            Acá aparecerán los pendientes y faltantes más urgentes. Todavía sin datos.
          </p>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="rounded-lg bg-muted/60 px-3 py-2">Sin urgencias registradas</li>
          </ul>
        </Card>

        {/* Semáforo (placeholder + leyenda accesible) */}
        <Card className="space-y-3">
          <CardTitle>Semáforo de entregas</CardTitle>
          <p className="text-sm text-muted-foreground">
            Cada estado se muestra con color y texto (nunca solo color).
          </p>
          <div className="flex flex-col gap-2">
            <StatusPill tone="success" label="A tiempo" />
            <StatusPill tone="warning" label="Por vencer" />
            <StatusPill tone="danger" label="Vencido / crítico" />
          </div>
        </Card>
      </div>
    </div>
  );
}
