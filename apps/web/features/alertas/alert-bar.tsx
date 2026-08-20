import Link from "next/link";

import { Alert, type AlertTone } from "@/app/_components/ui/alert";
import { alertSignature, type AlertCounts } from "@/lib/alertas/signature";
import { can, seesAllPendings } from "@/lib/auth/permissions";
import type { SessionRole } from "@/lib/auth/session";
import { cn } from "@/lib/utils/cn";
import {
  getOperationalAlertsCached,
  type AlertScope,
} from "@/server/services/operational-alerts.service";

import {
  AlertSnoozeWrapper,
  type AlertSnoozeChip,
  type AlertSnoozeSeverity,
} from "./alert-snooze";

const ALERT_SEVERITY = {
  DANGER: "danger",
  WARNING: "warning",
} as const;

type AlertSeverity = AlertSnoozeSeverity;

type AlertChip = AlertSnoozeChip;

type AlertBarProps = {
  userId: string;
  role: SessionRole;
};

function totalAlerts(counts: AlertCounts): number {
  return (
    counts.expiredBatches +
    counts.criticalBatches +
    counts.overdueDeliveries +
    counts.upcomingDeliveries +
    counts.criticalMissing
  );
}

function buildAlertChips(counts: AlertCounts): AlertChip[] {
  const chipCandidates: AlertChip[] = [
    {
      severity: ALERT_SEVERITY.DANGER,
      label: "Vencidos",
      count: counts.expiredBatches,
      href: "/productos",
    },
    {
      severity: ALERT_SEVERITY.DANGER,
      label: "Atrasadas",
      count: counts.overdueDeliveries,
      href: "/pendientes",
    },
    {
      severity: ALERT_SEVERITY.WARNING,
      label: "Críticos",
      count: counts.criticalBatches,
      href: "/productos",
    },
    {
      severity: ALERT_SEVERITY.WARNING,
      label: "Próximas",
      count: counts.upcomingDeliveries,
      href: "/pendientes",
    },
    {
      severity: ALERT_SEVERITY.DANGER,
      label: "Faltantes críticos",
      count: counts.criticalMissing,
      href: "/faltantes",
    },
  ];

  return chipCandidates.filter((chip) => chip.count > 0);
}

function highestSeverity(chips: AlertChip[]): AlertSeverity {
  return chips.some((chip) => chip.severity === ALERT_SEVERITY.DANGER)
    ? ALERT_SEVERITY.DANGER
    : ALERT_SEVERITY.WARNING;
}

function chipClasses(severity: AlertSeverity): string {
  return cn(
    "inline-flex min-h-11 items-center gap-2 rounded-full border px-3 py-2 text-sm font-semibold transition-opacity duration-[250ms] ease-in-out",
    severity === ALERT_SEVERITY.DANGER &&
      "border-danger/30 bg-danger/10 text-danger hover:bg-danger/15",
    severity === ALERT_SEVERITY.WARNING &&
      "border-warning/30 bg-warning/10 text-warning-foreground hover:bg-warning/15",
  );
}

type OperationalAlertContentProps = {
  chips: AlertChip[];
  severity: AlertSeverity;
  totalCount: number;
};

function OperationalAlertContent({
  chips,
  severity,
  totalCount,
}: OperationalAlertContentProps) {
  const tone: AlertTone = severity === ALERT_SEVERITY.DANGER ? "danger" : "warning";
  const role = severity === ALERT_SEVERITY.DANGER ? "alert" : "status";
  const severityLabel = severity === ALERT_SEVERITY.DANGER ? "Alerta operativa" : "Aviso operativo";

  return (
    <Alert tone={tone} role={role} className="space-y-3 shadow-sm">
      <details className="group sm:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-semibold">
          <span>
            {severityLabel} · {totalCount} aviso{totalCount === 1 ? "" : "s"}
          </span>
          <span className="text-xs uppercase tracking-wide text-muted-foreground group-open:hidden">
            Ver
          </span>
          <span className="hidden text-xs uppercase tracking-wide text-muted-foreground group-open:inline">
            Ocultar
          </span>
        </summary>
        <div className="mt-3 grid gap-2 transition-[height,opacity] duration-200 ease-in-out">
          {chips.map((chip) => (
            <Link key={chip.label} href={chip.href} className={chipClasses(chip.severity)}>
              <span>{chip.label}</span>
              <span>{chip.count}</span>
            </Link>
          ))}
        </div>
      </details>

      <div className="hidden items-center gap-3 sm:flex sm:flex-wrap">
        <span className="mr-1 text-sm font-semibold">{severityLabel}</span>
        {chips.map((chip) => (
          <Link key={chip.label} href={chip.href} className={chipClasses(chip.severity)}>
            <span>{chip.label}</span>
            <span>{chip.count}</span>
          </Link>
        ))}
      </div>
    </Alert>
  );
}

// El aviso le habla al responsable, no a quien pase por ahí.
//
// Gerencia y supervisión ven el estado de toda la droguería. El vendedor ve
// SOLO las entregas que él prometió: un lote por vencer no lo resuelve él. La
// bodega, desde que opera pendientes propios (T4.4), recibe el mismo recorte
// por dueño que el vendedor: sus entregas, no las ajenas.
function alertScopeFor(role: SessionRole, userId: string): AlertScope {
  if (seesAllPendings(role)) return { kind: "global" };
  if (can(role, "canViewPendientes")) return { kind: "owner", ownerId: userId };
  return { kind: "none" };
}

export async function AlertBar({ userId, role }: AlertBarProps) {
  // Mismo criterio que el aviso de gerencia: si la consulta falla, no se
  // muestra el aviso y la pantalla sigue funcionando. Un contador caído no
  // puede impedirle a nadie registrar un pendiente.
  let counts: AlertCounts;
  try {
    counts = await getOperationalAlertsCached(alertScopeFor(role, userId));
  } catch (error) {
    console.error("[alertas] No se pudo calcular el aviso operativo:", error);
    return null;
  }
  const totalCount = totalAlerts(counts);

  if (totalCount === 0) return null;

  const chips = buildAlertChips(counts);
  const severity = highestSeverity(chips);
  const signature = alertSignature(counts);

  return (
    <AlertSnoozeWrapper
      userId={userId}
      role={role}
      chips={chips}
      highestSeverity={severity}
      signature={signature}
      totalCount={totalCount}
    >
      <OperationalAlertContent
        chips={chips}
        severity={severity}
        totalCount={totalCount}
      />
    </AlertSnoozeWrapper>
  );
}
