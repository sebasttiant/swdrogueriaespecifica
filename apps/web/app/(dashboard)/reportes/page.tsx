import type { Metadata } from "next";
import {
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  Clock,
  PackageCheck,
  PackageMinus,
  PackageX,
} from "lucide-react";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { requireCapability } from "@/lib/auth/require-role";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { KpiCard } from "@/app/_components/ui/kpi-card";
import { PeriodFilter } from "@/features/reportes/period-filter";
import { ReportActions } from "@/features/reportes/report-actions";
import { StatusDonut } from "@/features/reportes/status-donut";
import { TrendBars } from "@/features/reportes/trend-bars";
import {
  REPORT_PERIOD_LABEL,
  getReportsAnalytics,
  parseReportsPeriod,
} from "@/server/services/reports.service";

export const metadata: Metadata = { title: "Reportes" };

// Datos reales en vivo: nunca cachear.
export const dynamic = "force-dynamic";

// Porcentaje entero de `part` sobre `total` (0 si no hay total).
function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

type ReportesPageProps = {
  searchParams: Promise<{ period?: string }>;
};

export default async function ReportesPage({ searchParams }: ReportesPageProps) {
  // Módulo sensible: requiere la capability de reportes. El nav ya oculta el link;
  // este guard protege el acceso directo a la ruta (sin la capability va a su home).
  await requireCapability("canViewReports");

  const { period: periodParam } = await searchParams;
  const period = parseReportsPeriod(periodParam);
  const { summary, pendingsByStatus, missingByStatus, trend } =
    await getReportsAnalytics(period);

  const periodLabel = REPORT_PERIOD_LABEL[period];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reportes"
        description="KPIs de la operación: estado, distribución y tendencia."
      />

      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted-foreground">
          Distribución y tendencia de los últimos {periodLabel}.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodFilter active={period} />
          <ReportActions period={period} />
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-text">Pendientes</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <KpiCard
            label="Total"
            value={summary.pendings.total}
            icon={ClipboardList}
            tone="primary"
            href="/pendientes"
          />
          <KpiCard
            label="Abiertos"
            value={summary.pendings.open}
            icon={Clock}
            tone="warning"
            hint={`${pct(summary.pendings.open, summary.pendings.total)}% del total`}
            href="/pendientes"
          />
          <KpiCard
            label="Cerrados"
            value={summary.pendings.closed}
            icon={ClipboardCheck}
            tone="success"
            hint={`${pct(summary.pendings.closed, summary.pendings.total)}% cerrados`}
          />
        </div>
        <Card className="space-y-3">
          <CardTitle className="text-sm">
            Distribución por estado ({periodLabel})
          </CardTitle>
          <StatusDonut data={pendingsByStatus} unitLabel="pendientes" />
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-text">Faltantes</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Total"
            value={summary.missing.total}
            icon={PackageX}
            tone="primary"
            href="/faltantes"
          />
          <KpiCard
            label="Abiertos"
            value={summary.missing.open}
            icon={PackageMinus}
            tone="danger"
            hint={`${pct(summary.missing.open, summary.missing.total)}% sin cerrar`}
            href="/faltantes"
          />
          <KpiCard
            label="Cerrados"
            value={summary.missing.closed}
            icon={PackageCheck}
            tone="success"
            hint={`${pct(summary.missing.closed, summary.missing.total)}% cerrados`}
          />
          <KpiCard
            label="Creados hoy"
            value={summary.missing.createdToday}
            icon={CalendarClock}
            tone="warning"
          />
        </div>
        <Card className="space-y-3">
          <CardTitle className="text-sm">
            Distribución por estado ({periodLabel})
          </CardTitle>
          <StatusDonut data={missingByStatus} unitLabel="faltantes" />
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-text">Tendencia de creación por día</h2>
        <Card className="space-y-3">
          <CardTitle className="text-sm">
            Pendientes vs faltantes ({periodLabel})
          </CardTitle>
          <TrendBars data={trend} />
        </Card>
      </section>
    </div>
  );
}
