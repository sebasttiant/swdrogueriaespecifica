import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Alert } from "@/app/_components/ui/alert";
import { staleMissingHref } from "@/features/faltantes/missing-stale";
import { isAdminRole } from "@/lib/auth/permissions";
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
  if (!isAdminRole(role)) return null;

  // Un aviso es información de apoyo: si su consulta falla, la respuesta correcta
  // es no mostrar nada, no tumbar la pantalla que la persona vino a usar.
  let alert: Awaited<ReturnType<typeof getManagementMissingAlert>>;
  try {
    alert = await getManagementMissingAlert(now);
  } catch (error) {
    console.error("[alertas] No se pudo calcular el aviso de gerencia:", error);
    return null;
  }
  if (!alert.active) return null;

  return (
    <div className="px-4 pt-4 lg:px-8">
      <div className="mx-auto w-full max-w-5xl">
        <Alert
          tone="danger"
          role="alert"
          className="flex items-start gap-3 shadow-sm"
        >
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
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
              {/* A la cola de REVISIÓN, no a `/faltantes` —esa es la pantalla
                  de captura, y quien toca este aviso viene a cerrar los que ya
                  existen, no a cargar otro—, Y CON EL FILTRO PUESTO.

                  Sin el filtro, el aviso decía "86 llevan más de 8 h" y abría
                  la cola entera: 126 faltantes de a 20 por página, con esos 86
                  mezclados adentro y los más viejos al final, porque la lista
                  ordena por fecha descendente. El número prometía una cosa y el
                  destino entregaba otra. */}
              <Link
                prefetch={false}
                href={staleMissingHref()}
                className="font-semibold text-primary underline"
              >
                Revisar los atrasados
              </Link>
            </p>
          </div>
        </Alert>
      </div>
    </div>
  );
}
