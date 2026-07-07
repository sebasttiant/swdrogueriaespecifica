import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Alert } from "@/app/_components/ui/alert";
import { hasRole } from "@/lib/auth/require-role";
import type { SessionRole } from "@/lib/auth/session";
import {
  UNCLOSED_MISSING_ALERT_HOURS,
  getManagementMissingAlert,
} from "@/server/services/reports.service";

type ManagementMissingAlertProps = {
  role: SessionRole;
  now?: Date;
};

// Aviso de gerencia sobre faltantes sin cerrar. Se monta en el AppShell, así que
// aparece arriba en TODA la app. Solo para ADMIN/SUPERADMIN. No es posponible: la
// idea es que no se pase por alto mientras la condición siga activa.
export async function ManagementMissingAlert({
  role,
  now = new Date(),
}: ManagementMissingAlertProps) {
  if (!hasRole(role, ["SUPERADMIN", "ADMIN"])) return null;

  const alert = await getManagementMissingAlert(now);
  if (!alert.active) return null;

  return (
    <div className="px-4 pt-4 lg:px-8">
      <div className="mx-auto w-full max-w-5xl">
        <Alert
          tone="danger"
          role="alert"
          className="flex items-start gap-3 shadow-sm"
        >
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p className="text-base font-semibold">
              Estos faltantes no se han cerrado
            </p>
            <p className="text-sm">
              {alert.unclosedOverThreshold > 0 ? (
                <>
                  {alert.unclosedOverThreshold} faltante
                  {alert.unclosedOverThreshold === 1 ? "" : "s"} llevan más de{" "}
                  {UNCLOSED_MISSING_ALERT_HOURS} h sin cerrarse.{" "}
                </>
              ) : null}
              {alert.exceedsDailyThreshold ? (
                <>Hoy se generaron {alert.createdToday} faltantes. </>
              ) : null}
              <Link href="/faltantes" className="font-semibold underline">
                Revisar faltantes
              </Link>
            </p>
          </div>
        </Alert>
      </div>
    </div>
  );
}
