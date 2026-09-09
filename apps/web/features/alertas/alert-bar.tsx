import Link from "next/link";

import { Alert, type AlertTone } from "@/app/_components/ui/alert";
import { alertSignature, type AlertCounts } from "@/lib/alertas/signature";
import { can, seesAllPendings } from "@/lib/auth/permissions";
import type { SessionRole } from "@/lib/auth/session";
import {
  pendingDeadlineHref,
  pendingReviewListHref,
  supplyOverdueHref,
} from "@/features/pendientes/pending-anchor";
import {
  EXPIRY_TIER_LABELS,
  vencimientosHref,
} from "@/features/vencimientos/expiry-tier";
import { cn } from "@/lib/utils/cn";
import { countArrivalNotices } from "@/server/services/arrival-notice.service";
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
    counts.warningBatches +
    counts.overdueDeliveries +
    counts.upcomingDeliveries +
    counts.criticalMissing +
    counts.stockoutProducts
  );
}

function buildAlertChips(counts: AlertCounts): AlertChip[] {
  const chipCandidates: AlertChip[] = [
    // Las tres franjas de vencimiento abren la MISMA pantalla, cada una en su
    // pestaña. Antes las dos primeras caían en `/productos`, que empieza por el
    // formulario de "Nuevo producto" y sigue con el catálogo entero sin
    // filtrar: el chip decía "3" y dejaba a la persona buscándolos a mano.
    //
    // Las etiquetas salen del mismo vocabulario que titula las pestañas, así
    // que el chip y la pantalla que abre se llaman igual.
    {
      severity: ALERT_SEVERITY.DANGER,
      label: EXPIRY_TIER_LABELS.expired,
      count: counts.expiredBatches,
      href: vencimientosHref({ tier: "expired" }),
    },
    // A SEGUIMIENTO y ya filtrado. Antes caía en `/pendientes`, la pantalla de
    // captura: el chip decía "4 atrasadas" y abría el formulario de cargar uno
    // nuevo, con la cola entera sin filtrar debajo.
    {
      severity: ALERT_SEVERITY.DANGER,
      label: "Atrasadas",
      count: counts.overdueDeliveries,
      href: pendingDeadlineHref("atrasadas"),
    },
    {
      severity: ALERT_SEVERITY.WARNING,
      label: EXPIRY_TIER_LABELS.critical,
      count: counts.criticalBatches,
      href: vencimientosHref({ tier: "critical" }),
    },
    // El aviso con tres meses de antelación. Se calculaba desde siempre y no
    // llegaba a la barra: sin él, la primera noticia de que un lote se vence
    // llega a 30 días, cuando ya casi no hay margen para devolverlo o rotarlo.
    {
      severity: ALERT_SEVERITY.WARNING,
      label: EXPIRY_TIER_LABELS.warning,
      count: counts.warningBatches,
      href: vencimientosHref({ tier: "warning" }),
    },
    {
      severity: ALERT_SEVERITY.WARNING,
      label: "Próximas",
      count: counts.upcomingDeliveries,
      href: pendingDeadlineHref("proximas"),
    },
    // NO SE LLAMA "Faltantes críticos", y el nombre viejo no era un detalle: en
    // el vocabulario del sistema un "faltante" es de ESTANTERÍA —lo que se
    // repone— y se resuelve en `/revision-faltantes`. Este contador cuenta lo
    // contrario: productos que un CLIENTE encargó, con fecha prometida ya
    // vencida, y que todavía no se consiguieron. El nombre mandaba a buscarlos
    // a la pantalla equivocada.
    //
    // Por eso mismo va a ABASTECIMIENTO y no a `/faltantes` (la pantalla de
    // reportar uno nuevo) ni a `/revision-faltantes` (que filtra
    // `origin: "shelf"`, el conjunto disjunto de este). Ver `supplyOverdueHref`.
    {
      severity: ALERT_SEVERITY.DANGER,
      label: "Pedidos sin conseguir",
      count: counts.criticalMissing,
      href: supplyOverdueHref(),
    },
    // Un producto QUE LLEVAMOS se quedó sin con qué cubrir lo prometido.
    // Enlaza a la mitad de abastecimiento de Revisión de pendientes, que es
    // donde se resuelve: ahí bodega marca la llegada y carga la entrada.
    {
      severity: ALERT_SEVERITY.DANGER,
      label: "Sin stock",
      count: counts.stockoutProducts,
      href: "/revision-pendientes?tab=abastecimiento",
    },
  ];

  return chipCandidates.filter((chip) => chip.count > 0);
}

function highestSeverity(chips: AlertChip[]): AlertSeverity {
  return chips.some((chip) => chip.severity === ALERT_SEVERITY.DANGER)
    ? ALERT_SEVERITY.DANGER
    : ALERT_SEVERITY.WARNING;
}

// EL COLOR VIAJA EN UN PUNTO, NO EN EL RELLENO DEL CHIP.
//
// Tercera vuelta sobre lo mismo, y la lección se repite en cada nivel. Primero
// la barra entera era roja y los chips desaparecían adentro. Después la barra
// se calmó y los chips pasaron a relleno pleno: quedaron CUATRO pastillas rojas
// saturadas en fila, y volvió a pasar lo de siempre —si cuatro de cinco gritan,
// ninguna se destaca—. Peor todavía: al lado de esas cuatro, el chip de
// advertencia con su tinte ámbar se leía como un control DESHABILITADO.
//
// El problema de fondo no es el color: es que hay cuatro métricas clasificadas
// como peligro al mismo tiempo. Ninguna paleta sobrevive a eso. Lo que sí se
// puede hacer es dejar de gastar el rojo en superficies: todos los chips
// comparten la misma pastilla neutra, y la severidad va en un PUNTO. El ojo
// distingue igual —el punto es lo único que cambia, así que es lo único que
// mira—, la advertencia recupera su ámbar porque ya no compite contra cuatro
// rellenos, y la fila deja de ser un semáforo roto.
//
// Los dos tokens de rojo NO son intercambiables acá:
// - el PUNTO usa `danger-solid`, que vale lo mismo en claro y en oscuro. Ocho
//   píxeles no tienen margen para compensar: con el token adaptativo el punto
//   se vuelve rosa en oscuro y deja de leerse como peligro.
// - el FILO del `Alert` usa `danger`, que se aclara en oscuro. Cuatro píxeles
//   contra una superficie oscura necesitan justo lo contrario. Es el mismo
//   criterio de la tarjeta "Estado general" del tablero.
//
// Y el punto nunca va solo: la etiqueta dice qué es. Es la regla que encabeza
// `globals.css` — "estados SIEMPRE acompañados de texto, nunca solo color".
function chipClasses(): string {
  return cn(
    "inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface px-3 py-2 text-sm font-semibold text-text",
    "transition-colors duration-[250ms] ease-in-out hover:border-muted-foreground",
  );
}

function chipDotClasses(severity: AlertSeverity): string {
  return cn(
    "size-2 shrink-0 rounded-full",
    severity === ALERT_SEVERITY.DANGER && "bg-danger-solid",
    severity === ALERT_SEVERITY.WARNING && "bg-warning",
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
  // NEUTRO siempre. El contenedor no se tiñe por severidad —de eso se encargan
  // los chips—, pero el `role` SÍ la sigue: quien usa lector de pantalla
  // necesita que un peligro se anuncie de inmediato (`alert`) y un aviso entre
  // por la cola cortés (`status`). Lo que cambia es el color, no la urgencia.
  const tone: AlertTone = "neutral";
  const role = severity === ALERT_SEVERITY.DANGER ? "alert" : "status";
  const severityLabel = severity === ALERT_SEVERITY.DANGER ? "Alerta operativa" : "Aviso operativo";

  return (
    <Alert tone={tone} role={role} className="space-y-3 shadow-sm">
      <details className="group sm:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-semibold">
          <span>
            {severityLabel} · {totalCount} aviso{totalCount === 1 ? "" : "s"}
          </span>
          {/* El gris de superficies neutras vuelve a ser el correcto porque la
              barra VOLVIÓ a ser neutra. Mientras fue roja plena quedaba
              ilegible: un control no puede heredar un color pensado para otro
              fondo. */}
          <span className="text-xs uppercase tracking-wide text-muted-foreground group-open:hidden">
            Ver
          </span>
          <span className="hidden text-xs uppercase tracking-wide text-muted-foreground group-open:inline">
            Ocultar
          </span>
        </summary>
        <div className="mt-3 grid gap-2 transition-[height,opacity] duration-200 ease-in-out">
          {chips.map((chip) => (
            <Link prefetch={false} key={chip.label} href={chip.href} className={chipClasses()}>
              <span className={chipDotClasses(chip.severity)} aria-hidden />
              <span>{chip.label}</span>
              <span>{chip.count}</span>
            </Link>
          ))}
        </div>
      </details>

      <div className="hidden items-center gap-3 sm:flex sm:flex-wrap">
        <span className="mr-1 text-sm font-semibold">{severityLabel}</span>
        {chips.map((chip) => (
          <Link prefetch={false} key={chip.label} href={chip.href} className={chipClasses()}>
            <span className={chipDotClasses(chip.severity)} aria-hidden />
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
// bodega recibe UN solo aviso, el suyo: un producto que la droguería lleva se
// quedó sin con qué cubrir lo prometido, y antes de comprarlo hay que mirar el
// depósito.
function alertScopeFor(role: SessionRole, userId: string): AlertScope {
  if (seesAllPendings(role)) return { kind: "global" };
  // Bodega ANTES que el recorte por dueño: ve la cola completa de pendientes
  // (`canReadAllPendings`) pero no opera los ajenos, así que el recorte por
  // dueño la dejaba con las entregas que ella misma cargó —casi ninguna— y sin
  // el único aviso que sí puede resolver.
  if (can(role, "canReceiveMissingItems") && !can(role, "canOrderMissingItems")) {
    return { kind: "warehouse" };
  }
  if (can(role, "canViewPendientes")) return { kind: "owner", ownerId: userId };
  return { kind: "none" };
}

// --------------------------------------------------------------------------
// "Llegó lo que esperabas": el aviso que NO es un reclamo.
//
// Va SEPARADO del aviso operativo, y las tres diferencias son deliberadas:
//
// 1. TONO. El operativo es rojo o amarillo porque describe algo que va mal.
//    Este es una buena noticia. Meter "llegó tu pedido" en la misma barra
//    amarilla que "hay faltantes sin resolver hace 8 horas" enseña a ignorar
//    la barra entera, y un aviso que se ignora es peor que no tenerlo: deja
//    creyendo que se avisó.
//
// 2. NO SE POSPONE. El "Posponer 8 h" tiene sentido contra un reclamo que
//    insiste. Acá no hace falta: el aviso se limpia con la ACCIÓN —cuando el
//    vendedor entrega o cancela, el pendiente sale del filtro de estado y el
//    aviso desaparece solo—. Por eso queda FUERA de `AlertSnoozeWrapper`:
//    silenciar "tu mercadería llegó" es perder la venta.
//
// 3. SIN DETALLE. La barra se pinta en TODAS las pantallas y su único trabajo
//    es sacarte de donde estás. El cliente, la cantidad y la hora están en
//    `/pendientes`, a un toque. Repetir la tarjeta entera acá no informa más:
//    hace ruido, y en el celular desborda.
//
// Una sola línea y un enlace: en móvil no necesita colapsarse porque no hay
// nada que colapsar.
// --------------------------------------------------------------------------
function ArrivalNoticeAlert({ total }: { total: number }) {
  if (total === 0) return null;

  return (
    <Alert tone="success" role="status" className="shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="text-sm font-semibold">
          {total === 1
            ? "Llegó 1 pedido tuyo"
            : `Llegaron ${total} pedidos tuyos`}
        </span>
        {/* A Revisión de pendientes, no a la pantalla de captura: quien
            recibe este aviso tiene que ACTUAR sobre un pedido que ya existe
            —facturarlo, contactar al cliente—, no cargar uno nuevo. */}
        <Link
          prefetch={false}
          href={pendingReviewListHref()}
          className="inline-flex min-h-11 items-center rounded-full border border-success/30 px-3 text-sm font-semibold"
        >
          Ver
        </Link>
      </div>
    </Alert>
  );
}

export async function AlertBar({ userId, role }: AlertBarProps) {
  // El aviso de llegada NO depende del operativo, ni en el contenido ni en el
  // fallo: que no haya nada que reclamar —o que esa consulta se caiga— no
  // significa que no haya llegado mercadería. Se arma primero, antes del try,
  // para que ningún camino de error se lo lleve puesto.
  //
  // Se cuenta acá y no dentro del componente para que este quede SINCRÓNICO:
  // un componente async anidado solo se puede pintar en un render de servidor
  // completo, y eso deja la barra sin forma de probarse.
  let arrivalCount = 0;
  try {
    arrivalCount = await countArrivalNotices(userId);
  } catch (error) {
    // Un contador caído no puede impedirle a nadie registrar un pendiente, ni
    // llevarse puesto el aviso operativo.
    console.error("[alertas] No se pudo contar los avisos de llegada:", error);
  }
  const arrival = <ArrivalNoticeAlert total={arrivalCount} />;

  // Mismo criterio que el aviso de gerencia: si la consulta falla, no se
  // muestra ESE aviso y la pantalla sigue funcionando. Un contador caído no
  // puede impedirle a nadie registrar un pendiente.
  let counts: AlertCounts;
  try {
    counts = await getOperationalAlertsCached(alertScopeFor(role, userId));
  } catch (error) {
    console.error("[alertas] No se pudo calcular el aviso operativo:", error);
    return arrival;
  }
  const totalCount = totalAlerts(counts);

  if (totalCount === 0) return arrival;

  const chips = buildAlertChips(counts);
  const severity = highestSeverity(chips);
  const signature = alertSignature(counts);

  return (
    <div className="space-y-3">
      {arrival}
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
    </div>
  );
}
