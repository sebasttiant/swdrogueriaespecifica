import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/app/_components/app-shell/page-header";
import { Card, CardTitle } from "@/app/_components/ui/card";
import {
  MissingCreateForm,
} from "@/features/faltantes/missing-create-form";
import { MissingReportForm } from "@/features/faltantes/missing-report-form";
import { MyMissingReports } from "@/features/faltantes/my-missing-reports";
import { REVIEW_QUEUE_PATH } from "@/features/faltantes/report-queue-paging";
import { MissingSummary } from "@/features/faltantes/missing-summary";
import { can } from "@/lib/auth/permissions";
import { requireCapability } from "@/lib/auth/require-role";
import { getMissingItemsSummary } from "@/server/services/missing-item.service";
import { getMyMissingReports } from "@/server/services/missing-report.service";

export const metadata: Metadata = { title: "Faltantes" };

// Sin `searchParams`: la mesa de trabajo se mudó a Revisión de faltantes y con
// ella los ejes de la URL. Quedaba un destructuring vacío —`({ })`— que exigía
// un argumento para nada.
export default async function FaltantesPage() {
  const session = await requireCapability("canViewFaltantes");
	const canOrderMissingItems = can(session.user.role, "canOrderMissingItems");
	const canCreateMissingItems = can(session.user.role, "canCreateMissingItems");
	const canSubmitMissingReports = can(session.user.role, "canSubmitMissingReports");
	const canReviewMissingReports = can(session.user.role, "canReviewMissingReports");
	const canViewCustomerIdentity = can(session.user.role, "canViewCustomerIdentity");
	// De quién compra la droguería: solo gerencia. El service ya lo minimiza,
	// así que esto último solo evita renderizar una columna que vendría vacía.
	const canViewSupplierIdentity = can(session.user.role, "canViewSupplierIdentity");
	// Descargar la cola a un archivo: solo gerencia. El vendedor ve la cola pero
	// no se la lleva.
	const canExportFaltantes = can(session.user.role, "canExportFaltantes");
	// --------------------------------------------------------------------------
	// La COLA de faltantes —pestañas por estado, listado completo, casillas de
	// descarte— es la mesa de trabajo de gerencia, no del vendedor.
	//
	// El vendedor reporta y se va: "yo tengo un faltante, lo coloco, coloco mi
	// nombre y ya dejo que Andrés y don Guillermo hagan lo que quieran con eso".
	// Mostrarle "Por pedir" y "Descartados" le pedía opinar sobre decisiones que
	// no toma. Él ve SUS reportes y en qué estado quedaron, y nada más.
	//
	// El atajo se ofrece con la MISMA capacidad que abre la puerta
	// (`canReceiveMissingItems`, el guard de `/revision-faltantes`), no con una
	// parecida. Antes se gateaba con `canConfirmMissingItems`: SUPERVISOR la
	// tiene, veía la tarjeta, la tocaba y el guard lo rebotaba al dashboard sin
	// decirle nada. Un enlace a una puerta cerrada es peor que no tener enlace.
	// --------------------------------------------------------------------------
	const canSeeMissingQueue = can(session.user.role, "canReceiveMissingItems");

  // Un único instante compartido por el resumen global y el agrupamiento de
  // la página actual, para que ambos hablen del mismo "ahora".
  const [summary, myReports] = await Promise.all([
    // Si la pantalla dice "Faltantes", el número tiene que ser de faltantes de
    // estantería. Global, decía 47 y Revisión de faltantes mostraba 12: los
    // otros 35 eran pedidos de clientes, que se compran en Revisión de
    // pendientes. Un indicador que no cuadra con ninguna pantalla no orienta,
    // enseña a desconfiar del número.
    getMissingItemsSummary(new Date(), "shelf"),
    canSubmitMissingReports ? getMyMissingReports(session.user.id) : Promise.resolve([]),
  ]);

  // Orden deliberado y compacto: título → chips → cola. Todo lo que se
  // interponga entre abrir la página y tocar una acción es peso muerto en el
  // celular del gerente. El análisis vive en `/reportes`.
  return (
    <div className="space-y-4">
      <PageHeader title="Faltantes" description="Lo que hay que conseguir." />

      <MissingSummary summary={summary} />

      {/* Atajo de gerencia a la cola de revisión. Link plano a propósito:
          un contador obligaría a una consulta extra en cada carga de esta
          pantalla, que es la del vendedor en el celular. */}
      {canReviewMissingReports ? (
        <Link prefetch={false}
          href={REVIEW_QUEUE_PATH}
          className="inline-block text-sm font-semibold text-primary hover:underline print:hidden"
        >
          Revisar reportes de vendedores
        </Link>
      ) : null}

      {/* Reporte del vendedor: pegar un nombre desde Orión y avisar que falta.
          Es un eje aparte del alta catalogada de gerencia (abajo): distinto
          permiso, distinta tarjeta, distinto texto. Un OPERADOR ve esto y NADA
          del flujo administrativo. */}
      {canSubmitMissingReports ? (
        <Card className="space-y-3 p-3 print:hidden">
          <CardTitle>Reportar faltante</CardTitle>
          <MissingReportForm />
        </Card>
      ) : null}

      {canSubmitMissingReports ? <MyMissingReports reports={myReports} /> : null}

      {canCreateMissingItems ? (
        <Card className="space-y-3 p-3 print:hidden">
          <CardTitle>Alta manual catalogada</CardTitle>
          <MissingCreateForm />
        </Card>
      ) : null}

      {/* La mesa de trabajo —qué pedir, qué descartar— se mudó a Revisión de
          faltantes, que es donde se pidió que gerencia revise para pedir y
          bodega marque la llegada. Acá queda la CAPTURA: reportar, ver mis
          reportes y dar de alta. Antes las dos pantallas se llamaban casi
          igual y mostraban las mismas pestañas sobre modelos distintos. */}
      {canSeeMissingQueue ? (
        <Card className="p-3 print:hidden">
          <Link
            prefetch={false}
            href="/revision-faltantes"
            className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-2"
          >
            Ir a Revisión de faltantes
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">
            Ahí se decide qué pedir y qué descartar, y bodega marca lo que llega.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
