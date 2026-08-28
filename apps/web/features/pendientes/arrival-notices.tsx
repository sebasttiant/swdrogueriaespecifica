import Link from "next/link";

import { Alert } from "@/app/_components/ui/alert";
import type { ArrivalNotice } from "@/server/services/arrival-notice.service";

// --------------------------------------------------------------------------
// "Ya llegó": lo primero que el vendedor tiene que ver al abrir Pendientes.
//
// Va arriba de todo y sin plegar. Un aviso que hay que ir a buscar no es un
// aviso: hasta ahora el evento se encolaba correctamente y no se mostraba en
// ningún lado, que para el vendedor es exactamente lo mismo que no existir.
//
// Componente de servidor puro: sin estado, sin efectos, sin polling. Se
// recalcula con cada visita a la página, que es cuando el vendedor mira.
// --------------------------------------------------------------------------

export type ArrivalNoticesProps = {
  notices: ArrivalNotice[];
  /** Si el vendedor puede ver el nombre del cliente (PII, se minimiza server-side). */
  canViewCustomerIdentity: boolean;
};

function tituloDe(notice: ArrivalNotice): string {
  return notice.availabilityStatus === "DISPONIBLE_COMPLETO"
    ? "Llegó completo"
    : "Llegó una parte";
}

export function ArrivalNotices({
  notices,
  canViewCustomerIdentity,
}: ArrivalNoticesProps) {
  // Sin avisos no se renderiza nada: un cartel vacío que dice "no hay nada"
  // ocupa el lugar de arriba todos los días para no informar nada.
  if (notices.length === 0) return null;

  return (
    <section aria-labelledby="avisos-llegada" className="space-y-2">
      <h2 id="avisos-llegada" className="text-sm font-semibold text-foreground">
        Ya llegó ({notices.length})
      </h2>

      <ul className="space-y-2">
        {notices.map((notice) => {
          const completo = notice.availabilityStatus === "DISPONIBLE_COMPLETO";
          return (
            <li key={notice.pendingId}>
              <Alert tone={completo ? "success" : "warning"} role="status">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0">
                    <span className="font-semibold">{tituloDe(notice)}: </span>
                    <span className="font-medium">{notice.productName}</span>
                    {canViewCustomerIdentity && notice.customerName ? (
                      <span> — {notice.customerName}</span>
                    ) : null}
                  </div>

                  <Link
                    href={`/pendientes?view=listado#pendiente-${notice.pendingId}`}
                    className="shrink-0 text-sm font-semibold underline underline-offset-2"
                  >
                    Ver el pendiente
                  </Link>
                </div>

                <p className="mt-1 text-sm">
                  {/* El número importa: con un parcial el vendedor tiene que
                      decidir si le factura lo que hay o espera el resto. */}
                  {notice.readyQuantity} de {notice.quantity} disponible
                  {notice.quantity === 1 ? "" : "s"}
                  {" · "}
                  <time dateTime={notice.noticedAt.toISOString()}>
                    avisado el{" "}
                    {notice.noticedAt.toLocaleDateString("es-CO", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </p>
              </Alert>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
