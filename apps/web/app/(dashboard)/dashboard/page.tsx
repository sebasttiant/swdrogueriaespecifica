import type { Metadata } from "next";
import {
  ClipboardList,
  PackageX,
  PackageMinus,
  CalendarClock,
  ClipboardPlus,
  PackagePlus,
  LayoutList,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { KpiCard } from "@/app/_components/ui/kpi-card";
import { QuickAction } from "@/app/_components/ui/quick-action";
import { StatusPill } from "@/app/_components/ui/status-pill";
import { cn } from "@/lib/utils/cn";
import {
  computeDeadlineStatus,
  type DeadlineStatus,
} from "@/features/pendientes/deadline-status";
import { getPendingDashboard } from "@/server/services/pending.service";
import { getOpenMissingCount } from "@/server/services/missing-item.service";
import { getExpiringBatchCounts } from "@/server/services/product-batch.service";
import { formatBogotaDate } from "@/lib/datetime/bogota";

export const metadata: Metadata = { title: "Dashboard" };

// Datos reales en vivo: nunca cachear.
export const dynamic = "force-dynamic";

const COLOMBIA_TIME_ZONE = "America/Bogota";

// Semáforo → pill (mismo criterio que el listado de pendientes).
const DEADLINE_PILL: Record<
  DeadlineStatus,
  { tone: "success" | "warning" | "danger" | "neutral"; label: string }
> = {
  VENCIDO: { tone: "danger", label: "Vencido" },
  VENCE_PRONTO: { tone: "warning", label: "Vence pronto" },
  A_TIEMPO: { tone: "success", label: "A tiempo" },
  FINALIZADO: { tone: "neutral", label: "Finalizado" },
};

function getGreeting(date: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat("es-CO", {
      hour: "numeric",
      hour12: false,
      timeZone: COLOMBIA_TIME_ZONE,
    }).format(date),
  );

  if (hour < 12) return "Buenos días";
  if (hour < 19) return "Buenas tardes";
  return "Buenas noches";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default async function DashboardPage() {
  const session = await requireCapability("canViewDashboard");
  const canViewCustomerIdentity = can(session.user.role, "canViewCustomerIdentity");
  const canManageAll = can(session.user.role, "canManageAllPendings");

  const now = new Date();
  const [dashboard, openMissingCount, expiringCounts] = await Promise.all([
    getPendingDashboard({ canViewCustomerIdentity, now, scope: canManageAll ? "global" : "owner", ownerId: canManageAll ? undefined : session.user.id }),
    getOpenMissingCount(),
    getExpiringBatchCounts(now),
  ]);

  const hasOverdue = dashboard.overdueCount > 0;
  const dateLabel = capitalize(
    new Intl.DateTimeFormat("es-CO", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: COLOMBIA_TIME_ZONE,
    }).format(now),
  );

  // D2: KPI = critical + warning only (expires NOT counted here).
  const expiringKpiCount = expiringCounts.critical + expiringCounts.warning;
  const expiringKpiTone =
    expiringCounts.critical > 0
      ? "danger"
      : expiringCounts.warning > 0
        ? "warning"
        : "success";
  const expiringKpiHint =
    expiringKpiCount === 0
      ? "No hay productos próximos a vencer"
      : `${expiringCounts.critical} críticos · ${expiringCounts.warning} por vencer`;

  // Delivery windows KPI: Atrasada (danger) / Próxima (warning)
  const deliveryTone =
    dashboard.overdueCount > 0
      ? "danger"
      : dashboard.upcomingCount > 0
        ? "warning"
        : "success";
  const deliveryHint =
    dashboard.overdueCount === 0 && dashboard.upcomingCount === 0
      ? "No hay entregas atrasadas"
      : `${dashboard.overdueCount} atrasada${dashboard.overdueCount === 1 ? "" : "s"} · ${dashboard.upcomingCount} próxima${dashboard.upcomingCount === 1 ? "" : "s"}`;

  return (
    <div className="space-y-6">
      <PageHeader title={`${getGreeting(now)} 👋`} description={dateLabel} />

      {/* Estado general de la operación — salud visible en 5 segundos:
          acento + icono según el tono (verde normal / rojo crítico). */}
      <Card
        className={cn(
          "flex flex-col gap-3 border-l-4 sm:flex-row sm:items-center sm:justify-between",
          hasOverdue ? "border-l-danger" : "border-l-success",
        )}
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-full",
              hasOverdue
                ? "bg-danger/10 text-danger"
                : "bg-success/15 text-success",
            )}
          >
            {hasOverdue ? (
              <AlertTriangle className="size-5" aria-hidden />
            ) : (
              <CheckCircle2 className="size-5" aria-hidden />
            )}
          </span>
          <div>
            <CardTitle>Estado general de la operación</CardTitle>
            <p className="text-sm text-muted-foreground">
              Resumen rápido del día según los pendientes.
            </p>
          </div>
        </div>
        <StatusPill
          tone={hasOverdue ? "danger" : "success"}
          className="sm:shrink-0"
          label={
            hasOverdue
              ? `${dashboard.overdueCount} pendiente${dashboard.overdueCount === 1 ? "" : "s"} vencido${dashboard.overdueCount === 1 ? "" : "s"}`
              : "Operación normal"
          }
        />
      </Card>

      {/* KPIs principales */}
      <section aria-label="Indicadores principales">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <KpiCard
            label="Pendientes abiertos"
            value={dashboard.openCount}
            icon={ClipboardList}
            tone="primary"
            hint={hasOverdue ? `${dashboard.overdueCount} vencido${dashboard.overdueCount === 1 ? "" : "s"}` : "Al día"}
            href="/pendientes"
          />
          <KpiCard
            label="Faltantes abiertos"
            value={openMissingCount}
            icon={PackageX}
            tone={openMissingCount > 0 ? "danger" : "success"}
            hint={openMissingCount > 0 ? "Requieren gestión" : "Sin faltantes"}
            href="/faltantes"
          />
          <KpiCard
            label="Entregas próximas / atrasadas"
            value={`${dashboard.overdueCount} / ${dashboard.upcomingCount}`}
            icon={PackageMinus}
            tone={deliveryTone}
            hint={deliveryHint}
            href="/pendientes"
          />
          <KpiCard
            label="Próximos vencimientos"
            value={expiringKpiCount}
            icon={CalendarClock}
            tone={expiringKpiTone}
            hint={expiringKpiHint}
            href="/productos"
          />
        </div>
      </section>

      {/* Acciones rápidas */}
      <section aria-label="Acciones rápidas">
        <h2 className="mb-3 text-lg font-semibold text-text">Acciones rápidas</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <QuickAction label="Nuevo pendiente" href="/pendientes" icon={ClipboardPlus} />
          <QuickAction label="Nuevo faltante" href="/faltantes" icon={PackageX} />
          <QuickAction label="Nueva entrada" href="/entradas" icon={PackagePlus} />
          <QuickAction label="Ver catálogo" href="/productos" icon={LayoutList} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Urgencias: pendientes abiertos que vencen antes, primero. */}
        <Card className="space-y-3">
          <CardTitle>Urgencias del día</CardTitle>
          {dashboard.urgent.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="Todo al día"
              description="Sin pendientes abiertos por ahora."
              className="py-6"
            />
          ) : (
            <ul className="space-y-2">
              {dashboard.urgent.map((pending) => {
                const deadline =
                  DEADLINE_PILL[
                    computeDeadlineStatus(pending.promisedAt, pending.status, now)
                  ];
                return (
                  <li
                    key={pending.id}
                    className="flex items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text">
                        {pending.product.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {pending.quantity} {pending.product.unit} ·{" "}
                        {formatBogotaDate(pending.promisedAt, { style: "datetime" })}
                      </p>
                    </div>
                    <StatusPill
                      tone={deadline.tone}
                      label={deadline.label}
                      className="shrink-0"
                    />
                  </li>
                );
              })}
            </ul>
          )}
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
