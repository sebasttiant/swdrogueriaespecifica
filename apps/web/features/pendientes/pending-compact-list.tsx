import Link from "next/link";
import { ClipboardCheck, Pencil } from "lucide-react";

import { Badge } from "@/app/_components/ui/badge";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import { formatCop } from "@/lib/format/currency";
import { cn } from "@/lib/utils/cn";
import type { PendingListItem } from "@/server/repositories/pending.repository";

import { computeDeadlineStatus } from "./deadline-status";
import { derivePaymentState } from "./payment-state";
import {
  fulfillmentNotice,
  invoiceAffordance,
  isTerminal,
  outstanding,
  type PendingViewer,
} from "./fulfillment-notice";
import { identityWarning } from "./identity-warning";
import { PRESENTATION_LABEL, presentationLabel } from "./presentation";
import {
  isManagementStatus,
  MANAGEMENT_STATUS_LABELS,
} from "./management-status";
import { canSetManagementStatus } from "./management-status";
import { PendingManagementStatusForm } from "./pending-management-status-form";
import { PendingCustomerLifecycleForm } from "./pending-customer-lifecycle-form";
import { PendingDeliverForm } from "./pending-deliver-form";
import { PendingCancelForm } from "./pending-cancel-form";
import { PendingPartialDecisionForm } from "./pending-partial-decision-form";

// --------------------------------------------------------------------------
// Vista LISTADO de pendientes — la que pidió el gerente en la reunión del
// 2026-07-30: "me falta que lo muestre en listado... un listadito, para que
// Andrés y don Guillermo sepan quién ha pedido qué, y que le puedan colocar el
// okay".
//
// Es la vista de COMPRAS, no la del vendedor. Por eso muestra menos, no más:
//
//   producto · cantidad · quién lo pidió · para cuándo · estado · acción
//
// Queda deliberadamente afuera todo lo que es del mostrador —cliente, teléfono,
// dirección, zona, abonos, entregado parcial—. Quien compra no necesita saber a
// qué cliente va: necesita ver rápido qué conseguir y marcarlo. La vista
// detallada conserva todo eso intacto para quien sí lo usa.
//
// El renglón por fila cabe de un vistazo. Con 36 pendientes a las 9:30 de la
// mañana, ese es el punto entero.
// --------------------------------------------------------------------------

type PendingCompactListProps = {
  items: PendingListItem[];
  // Autoridad de compras: habilita el "Ya lo pedí". La Server Action revalida
  // igual, así que esto solo evita ofrecer un control que sería rechazado.
  canOrder: boolean;
  // La vista compacta no puede cortar la cola en la primera página: el cursor
  // viene del mismo query paginado que alimenta la vista detallada.
  nextCursor: string | null;
  // La página construye la URL para conservar scope y formato al avanzar.
  pageHref: (cursor: string) => string;
  canDeliver?: boolean;
  // Quién mira. Reemplaza al viejo `canContactOrInvoice`: aquel booleano no
  // sabía de quién era la fila ni si había mercadería, así que ofrecía facturar
  // donde el servidor iba a rechazar.
  viewer: PendingViewer;
  canCancel?: boolean;
  // Corregir los datos del pedido. Gerencia sobre cualquiera; el vendedor sobre
  // el suyo y una sola vez, límite que hace cumplir el servidor.
  canEdit?: boolean;
  // Alcance global: decide si el límite de una corrección aplica a quien mira.
  canManageAll?: boolean;
  // Seguimiento = VER la jornada completa. Quien administra necesita leer, sobre
  // la MISMA fila, a qué cliente va, a qué zona, cuánto falta cobrar y qué anotó
  // el vendedor. Sin eso supervisar es abrir el detalle de cada pendiente, uno
  // por uno, con 36 en la cola a las 9:30 de la mañana.
  canFollowUp?: boolean;
};

// Urgencia como texto + color, nunca solo color: la mitad de las decisiones se
// toman de un vistazo y en un celular al sol.
const URGENCY: Record<
  ReturnType<typeof computeDeadlineStatus>,
  { label: string; tone: "danger" | "warning" | "success" | "neutral" }
> = {
  VENCIDO: { label: "Vencido", tone: "danger" },
  VENCE_PRONTO: { label: "Vence pronto", tone: "warning" },
  A_TIEMPO: { label: "A tiempo", tone: "success" },
  FINALIZADO: { label: "Finalizado", tone: "neutral" },
};

// Los estados de gestión viven en el MISMO enum que el ciclo de vida, así que
// "todavía sin gestionar" es `PENDIENTE`. Se dice "Por pedir" y no "Pendiente"
// porque en esta vista lo que importa es qué hacer, no cómo se llama el estado.
// El estado que le importa al negocio, con las palabras de la reunión:
// Pendiente → Facturado → Entregado o Cancelado.
//
// Lo que gerencia anota sobre la COMPRA (solicitado, en búsqueda, cotizando,
// agotado) es otro eje y viaja aparte, en `purchaseNote`: es información para
// el vendedor mientras su pendiente sigue pendiente, no el estado del pedido.
function lifecycleLabel(item: PendingListItem): { label: string; tone: "neutral" | "primary" | "success" | "danger" } {
  // T2.2b: ANTES del chequeo de customerStatus — un cierre parcial tiene
  // customerStatus ENTREGADO, pero rotularlo "Entregado" mentiría en el
  // historial: no se entregó todo.
  if (item.status === "CLOSED_PARTIAL") {
    return { label: "Cerrado parcial", tone: "danger" };
  }
  if (item.customerStatus === "ENTREGADO" || item.status === "ENTREGADO") {
    return { label: "Entregado", tone: "success" };
  }
  if (item.customerStatus === "CANCELADO" || item.status === "CANCELADO") {
    return { label: "Cancelado", tone: "danger" };
  }
  if (item.status === "PARCIAL") return { label: "Entrega parcial", tone: "primary" };
  if (item.customerStatus === "FACTURADO") return { label: "Facturado", tone: "primary" };
  return { label: "Pendiente", tone: "neutral" };
}

// La gestión de compras, cuando la hay. Se muestra DEBAJO del estado y solo
// mientras el pendiente sigue abierto: una vez facturado o entregado, saber que
// alguna vez estuvo "en búsqueda" ya no cambia ninguna decisión.
function purchaseNote(item: PendingListItem): string | null {
  if (isTerminal(item) || item.customerStatus === "FACTURADO") return null;
  const purchaseStatus = item.purchaseStatus ?? "POR_PEDIR";
  return isManagementStatus(purchaseStatus) ? MANAGEMENT_STATUS_LABELS[purchaseStatus] : null;
}

// Lo que el cliente respondió sobre lo que faltó. Se muestra para que la fila
// diga que la pregunta ya se contestó, en vez de volver a hacerla.
const PARTIAL_DECISION_LABELS = {
  ESPERA: "El cliente espera el resto",
  VA_CON_PEDIDO: "El resto va con otro pedido",
} as const;

function partialDecisionLabel(item: PendingListItem): string | null {
  if (!item.partialDecision) return null;
  return PARTIAL_DECISION_LABELS[item.partialDecision];
}

// El laboratorio pedido. Va pegado al producto —y NO dentro de la línea de
// seguimiento— porque es un dato del producto, no del cliente: dice qué
// presentación comprar. Metido en el seguimiento desaparecería para quien no
// tiene `canFollowUp`, que es justamente quien pide al proveedor.
function LaboratoryLine({ item }: { item: PendingListItem }) {
  if (!item.requestedLaboratory) return null;
  return (
    <p className="break-words text-xs text-muted-foreground">
      Lab: {item.requestedLaboratory.name}
    </p>
  );
}

// La presentación —frasco, sobre, caja— va pegada al producto por el mismo
// motivo que el laboratorio: es un dato del producto, y es parte de lo que se
// mira para decidir qué comprar y qué entregar.
//
// Como LÍNEA y no como columna nueva, igual que todo lo demás en esta lista:
// una columna más obliga a scroll horizontal y esto se mira desde el celular.
// Se muestra SIEMPRE, incluso vacía: "Sin presentación" es información —el
// producto no la tiene cargada—, mientras que un renglón ausente no distingue
// eso de un dato que no llegó a la pantalla.
//
// Informativa: acá no se edita. El catálogo es compartido.
function PresentationLine({ item }: { item: PendingListItem }) {
  return (
    <p className="break-words text-xs text-muted-foreground">
      {PRESENTATION_LABEL}: {presentationLabel(item.product.unit)}
    </p>
  );
}

// --------------------------------------------------------------------------
// La línea de SEGUIMIENTO.
//
// Seguimiento acá es VER, no actuar. Quien administra necesita mirar la jornada
// completa y entenderla sin abrir nada: a qué cliente va cada pendiente, a qué
// zona, cuánto falta cobrar y qué anotó el vendedor —"cliente espera", "va con
// pedido"—. Esa es la trazabilidad que pidieron: el día entero legible de
// corrido. Averiguarlo abriendo el detalle de cada uno, con 36 en la cola, no
// es supervisar.
//
// Va como una sola línea secundaria y no como columnas nuevas, a propósito: seis
// columnas más obligarían a scroll horizontal, y esto también se mira desde el
// celular. Los datos vacíos simplemente no aparecen; nada de guiones de relleno.
// --------------------------------------------------------------------------
function outstandingBalance(item: PendingListItem): number | null {
  if (item.totalAmount === null) return null;
  return Math.max(item.totalAmount - item.paidAmount, 0);
}

function FollowUpLine({ item }: { item: PendingListItem }) {
  const balance = outstandingBalance(item);
  const isPaid = derivePaymentState(item) === "PAGADO";
  const where = [item.zone, item.customerAddress].filter(Boolean).join(" · ");

  const hasAnything =
    item.customerName || item.customerPhone || where || balance !== null || item.note;
  if (!hasAnything) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {item.customerName ? (
        <span className="font-medium text-text">{item.customerName}</span>
      ) : null}

      {item.customerPhone ? <span>{item.customerPhone}</span> : null}

      {where ? <span>{where}</span> : null}

      {balance !== null && balance > 0 ? (
        <span className="font-semibold text-danger">Debe {formatCop(balance)}</span>
      ) : isPaid ? (
        <span className="font-medium text-success">Pagado</span>
      ) : null}

      {item.note ? <span className="italic">“{item.note}”</span> : null}
    </div>
  );
}

// Las acciones del DUEÑO del pendiente, en el orden en que ocurren:
// facturar, entregar, y cancelar como salida. Se arma una sola vez y se usa en
// las dos vistas para que móvil y escritorio no puedan divergir — que fue
// exactamente el bug que dejó al vendedor sin acciones en el computador.
type CustomerActionsContext = {
  viewer: PendingViewer;
  canDeliver: boolean;
  canCancel: boolean;
  // Gerencia corrige cualquier pendiente; el vendedor solo el suyo y una vez.
  // Acá solo se decide si OFRECER el enlace: quién puede de verdad lo resuelve
  // la página de edición y, en última instancia, la Server Action.
  canEdit: boolean;
  canManageAll: boolean;
};

function customerActions(item: PendingListItem, ctx: CustomerActionsContext) {
  if (isTerminal(item)) return null;

  // La MISMA condición que usa el aviso de texto de la fila y que vuelve a
  // aplicar el service. Móvil y escritorio la comparten porque comparten esta
  // función: fue la divergencia entre las dos vistas la que dejó al vendedor
  // sin acciones en el computador.
  const invoice =
    invoiceAffordance(item, ctx.viewer).canInvoice && showsCustomerActions(item) ? (
      <PendingCustomerLifecycleForm
        key="invoice"
        pendingId={item.id}
        customerStatus={item.customerStatus}
        quantity={item.quantity}
        invoicedQuantity={item.invoicedQuantity ?? 0}
      />
    ) : null;

  const deliver =
    ctx.canDeliver && outstanding(item).toDeliver > 0 ? (
      <PendingDeliverForm
        key="deliver"
        pendingId={item.id}
        remaining={outstanding(item).toDeliver}
      />
    ) : null;

  // Solo con una entrega parcial en curso: sin ninguna entrega no hay resto
  // sobre el que el cliente decida, y cerrar de cero es una cancelación.
  const partialDecision =
    ctx.canDeliver &&
    item.status === "PARCIAL" &&
    item.quantity > item.deliveredQuantity &&
    // Ya respondida: preguntar de nuevo hacía ver la acción como si no hubiera
    // funcionado. La respuesta se ve abajo, en el estado de la fila.
    !item.partialDecision ? (
      <PendingPartialDecisionForm
        key="partial-decision"
        pendingId={item.id}
        remaining={item.quantity - item.deliveredQuantity}
      />
    ) : null;

  const cancel = ctx.canCancel ? <PendingCancelForm key="cancel" pendingId={item.id} /> : null;

  // Al vendedor que ya usó su única corrección no se le ofrece: antes el botón
  // seguía ahí y lo llevaba a un 404 crudo, que parece un error del sistema y
  // no el límite que es.
  const edit = ctx.canEdit && (ctx.canManageAll || item.sellerEditedAt == null) ? (
    <Link prefetch={false}
      key="edit"
      href={`/pendientes/${item.id}/editar`}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-text"
    >
      <Pencil className="size-4" aria-hidden />
      Corregir
    </Link>
  ) : null;

  if (!invoice && !deliver && !partialDecision && !edit && !cancel) return null;
  return [invoice, deliver, partialDecision, edit, cancel];
}

// El vendedor puede actuar sobre su pendiente mientras no esté cerrado.
//
// Antes esto exigía que el sistema YA hubiera visto llegar la mercancía, y el
// resultado era una fila sin una sola acción: el vendedor miraba su propio
// pedido sin poder hacer nada con él. Quien factura es la persona; el software
// se entera después.
function showsCustomerActions(item: PendingListItem): boolean {
  return !isTerminal(item);
}

// El control de gestión se ofrece SIEMPRE que el estado lo admita, no solo
// cuando el pendiente está virgen. Antes el listado mostraba el estado y punto:
// para cambiar un "Solicitado" a "Agotado" había que irse a la vista detallada,
// justo la que gerencia no usa. El listado es la vista principal; tiene que
// poder resolver ahí mismo.
function canManage(item: PendingListItem): boolean {
  if (item.status === "PARCIAL" || isTerminal(item)) return false;
  return canSetManagementStatus(item.purchaseStatus ?? "POR_PEDIR");
}

export function PendingCompactList({
  items,
  canOrder,
  nextCursor,
  pageHref,
  canDeliver = false,
  viewer,
  canCancel = false,
  canEdit = false,
  canManageAll = false,
  canFollowUp = false,
}: PendingCompactListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={ClipboardCheck}
          title="No hay pendientes"
          description="Todo al día: no queda ningún pendiente por atender."
        />
      </Card>
    );
  }

  const now = new Date();

  return (
    <div className="space-y-3">
      {/* Celular: una fila por pendiente, apilada y sin scroll horizontal. */}
      <div className="space-y-2 lg:hidden">
        {items.map((pending) => {
          const urgency = URGENCY[
            computeDeadlineStatus(pending.promisedAt, pending.status, now)
          ];
          const notice = fulfillmentNotice(pending);
          const identityNotice = identityWarning(pending);
          const lifecycle = lifecycleLabel(pending);
          const purchase = purchaseNote(pending);
          const decision = partialDecisionLabel(pending);
          const actions = customerActions(pending, {
            viewer,
            canDeliver,
            canCancel,
            canEdit,
            canManageAll,
          });
          return (
            // SIN ancla, a propósito. Esta lista pinta las DOS vistas —tarjetas
            // y tabla— en el MISMO documento, ocultando una con CSS
            // (`lg:hidden` / `hidden lg:block`). Poner el `id` en las dos deja
            // dos elementos con el mismo identificador: HTML inválido, y el
            // navegador salta al PRIMERO, que en escritorio es la tarjeta
            // oculta. Saltar a un elemento `display:none` no hace nada —el
            // mismo síntoma que el defecto original.
            //
            // El ancla vive solo en `PendingList` (Revisión de pendientes), que
            // pinta una sola variante por fila. Nada enlaza acá con fragmento.
            <Card key={pending.id} className="space-y-2 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words font-medium text-text">
                    {pending.product.name}
                  </p>
                  {/* Va pegado al producto porque es del producto de lo que
                      habla: le falta el código de Orion. Se deriva del estado
                      actual, así que se apaga solo cuando alguien lo carga. */}
                  {identityNotice ? (
                    <Badge tone="warning">{identityNotice}</Badge>
                  ) : null}
                  <PresentationLine item={pending} />
                  <LaboratoryLine item={pending} />
                  <p className="break-words text-xs text-muted-foreground">
                    {pending.createdBy?.name ?? "Sin vendedor"}
                    {" · "}
                    {/* Quien hace seguimiento necesita la HORA comprometida, no
                        solo el día: "para hoy" y "para hoy a las 4" son dos
                        promesas distintas frente al cliente. */}
                    {formatBogotaDate(pending.promisedAt, {
                      style: canFollowUp ? "datetime" : "date",
                    })}
                  </p>
                  {canFollowUp ? <FollowUpLine item={pending} /> : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <p className="font-bold tabular-nums text-text">
                    {pending.quantity}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {pending.product.unit}
                    </span>
                  </p>
                  {/* El morado de la reunión: avisa que no se pide una unidad
                      sino varias. Con 36 pendientes a las 9:30 de la mañana,
                      leer mal la cantidad significa pedir de menos. */}
                  {pending.quantity > 1 ? <Badge tone="accent">Varias</Badge> : null}
                  <Badge tone={urgency.tone}>{urgency.label}</Badge>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={lifecycle.tone}>{lifecycle.label}</Badge>
                  {purchase ? (
                    <span className="text-xs text-muted-foreground">{purchase}</span>
                  ) : null}
                  {decision ? (
                    <span className="text-xs text-muted-foreground">{decision}</span>
                  ) : null}
                </div>
                {canOrder && canManage(pending) ? (
                  <PendingManagementStatusForm
                    pendingId={pending.id}
                    currentStatus={pending.purchaseStatus ?? "POR_PEDIR"}
                    hideCurrentLabel
                  />
                ) : null}
              </div>
              {notice ? (
                <Badge tone={notice.tone} className="w-full justify-center">
                  {notice.label}
                </Badge>
              ) : null}
              {actions ? (
                <div className="flex flex-wrap gap-2 border-t border-border pt-2">
                  {actions}
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      {/* Escritorio: la tabla que pidió el gerente. Seis columnas y nada más. */}
      <Card className="hidden overflow-x-auto p-0 lg:block">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Producto</th>
              <th className="px-3 py-2 font-medium">Cantidad</th>
              <th className="px-3 py-2 font-medium">Vendedor</th>
              <th className="px-3 py-2 font-medium">Para</th>
              <th className="px-3 py-2 font-medium">Estado</th>
              {canOrder || viewer.invoiceScope !== "none" || canDeliver || canCancel || canEdit ? (
                <th className="px-3 py-2 text-right font-medium">Acción</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {items.map((pending) => {
              const urgency = URGENCY[
                computeDeadlineStatus(pending.promisedAt, pending.status, now)
              ];
              const notice = fulfillmentNotice(pending);
              const identityNotice = identityWarning(pending);
              const lifecycle = lifecycleLabel(pending);
              const purchase = purchaseNote(pending);
              const decision = partialDecisionLabel(pending);
              const actions = customerActions(pending, {
                viewer,
                canDeliver,
                canCancel,
                canEdit,
                canManageAll,
              });
              return (
                <tr key={pending.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-medium text-text">
                    {pending.product.name}
                    {identityNotice ? (
                      <Badge tone="warning" className="ml-2">
                        {identityNotice}
                      </Badge>
                    ) : null}
                    <PresentationLine item={pending} />
                    <LaboratoryLine item={pending} />
                    {canFollowUp ? <FollowUpLine item={pending} /> : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      <span className={cn(pending.quantity > 1 && "font-semibold text-text")}>
                        {pending.quantity} {pending.product.unit}
                      </span>
                      {pending.quantity > 1 ? <Badge tone="accent">Varias</Badge> : null}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {pending.createdBy?.name ?? "—"}
                  </td>
                  <td className={cn("px-3 py-2 whitespace-nowrap", urgency.tone === "danger" && "font-semibold text-danger")}>
                    {formatBogotaDate(pending.promisedAt, {
                      style: canFollowUp ? "datetime" : "date",
                    })}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      <Badge tone={lifecycle.tone}>{lifecycle.label}</Badge>
                      {purchase ? (
                        <span className="text-xs text-muted-foreground">{purchase}</span>
                      ) : null}
                      {decision ? (
                        <span className="text-xs text-muted-foreground">{decision}</span>
                      ) : null}
                      {notice ? <Badge tone={notice.tone}>{notice.label}</Badge> : null}
                    </div>
                  </td>
                  {canOrder || viewer.invoiceScope !== "none" || canDeliver || canCancel || canEdit ? (
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-2">
                        {/* `canOrder` es autoridad de COMPRAS. Sin este chequeo
                            el vendedor veía "Ya lo pedí" y "Agotado" en la tabla
                            de escritorio —solo la vista móvil lo filtraba—, y
                            marcaba decisiones que no son suyas. */}
                        {canOrder && canManage(pending) ? (
                          <PendingManagementStatusForm
                            pendingId={pending.id}
                            currentStatus={pending.purchaseStatus ?? "POR_PEDIR"}
                            hideCurrentLabel
                          />
                        ) : null}
                        {actions}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {nextCursor ? (
        <div className="pt-1 text-center">
          <Link prefetch={false}
            href={pageHref(nextCursor)}
            className="inline-flex min-h-11 items-center px-4 text-sm font-semibold text-primary hover:underline"
          >
            Ver más
          </Link>
        </div>
      ) : null}
    </div>
  );
}
