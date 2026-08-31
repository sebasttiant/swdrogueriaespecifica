import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/pending.actions", () => ({
  deliverPendingAction: vi.fn(),
  cancelPendingAction: vi.fn(),
  updatePendingManagementStatusAction: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ArrivalNotice } from "@/server/services/arrival-notice.service";
import type { PendingListItem } from "@/server/repositories/pending.repository";

import { ArrivalNotices } from "./arrival-notices";
import { PendingList } from "./pending-list";

// --------------------------------------------------------------------------
// El aviso de llegada y la fila a la que lleva, probados JUNTOS.
//
// Esta es la prueba que faltaba, y su ausencia es todo el defecto.
//
// `arrival-notices.render.test.ts` ya afirmaba "enlaza al pendiente concreto"
// y pasaba en verde... mientras el enlace apuntaba a un ancla que NINGÚN
// componente escribía. Verificaba la mitad del par: que el `href` tuviera un
// fragmento. Nunca que ese fragmento existiera del otro lado.
//
// Resultado en producción: el vendedor hacía clic en "Ver el pendiente", el
// navegador no encontraba el destino, se quedaba arriba de la página —donde
// está el formulario de "Nuevo pendiente"— y parecía que el enlace no hacía
// nada. Un aviso que no lleva a ningún lado es peor que no tener aviso.
//
// Por eso acá se renderizan las DOS piezas y se comprueba que el destino del
// enlace exista de verdad en la lista.
// --------------------------------------------------------------------------

const PENDING_ID = "pend-42";

function notice(overrides: Partial<ArrivalNotice> = {}): ArrivalNotice {
  return {
    pendingId: PENDING_ID,
    productName: "Amoxicilina 500mg",
    quantity: 3,
    readyQuantity: 3,
    availabilityStatus: "DISPONIBLE_COMPLETO",
    customerName: null,
    noticedAt: new Date("2026-08-28T14:30:00Z"),
    ...overrides,
  };
}

function pending(overrides: Partial<PendingListItem> = {}): PendingListItem {
  return {
    id: PENDING_ID,
    quantity: 3,
    status: "PENDIENTE",
    promisedAt: new Date("2026-08-28T18:00:00.000Z"),
    customerName: null,
    note: null,
    customerPhone: null,
    customerAddress: null,
    createdBy: null,
    zone: null,
    totalAmount: null,
    paidAmount: 0,
    createdAt: new Date("2026-08-27T10:00:00.000Z"),
    deliveredQuantity: 0,
    cancelledQuantity: 0,
    identitySkippedReason: null,
    requestedLaboratory: null,
    product: {
      id: "prod-1",
      name: "Amoxicilina 500mg",
      code: "AMX-1",
      unit: "Caja",
      orionCode: null,
    },
    ...overrides,
  };
}

function renderNotices(): string {
  return renderToStaticMarkup(
    createElement(ArrivalNotices, {
      notices: [notice()],
      canViewCustomerIdentity: true,
    }),
  );
}

function renderList(items: PendingListItem[] = [pending()]): string {
  return renderToStaticMarkup(
    createElement(PendingList, {
      items,
      nextCursor: null,
      canDeliver: true,
      canCancel: true,
      canManageStatus: false,
      scope: "active" as const,
      pageHref: (cursor: string) => `?cursor=${cursor}`,
    }),
  );
}

/** El `#loquesea` del primer `href` del HTML dado. */
function fragmentoDelEnlace(html: string): string {
  const match = html.match(/href="[^"]*#([^"]+)"/);
  if (!match?.[1]) throw new Error("el aviso no enlaza a ningún fragmento");
  return match[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
});

describe("el aviso de llegada lleva a una fila que EXISTE", () => {
  it("el fragmento del enlace corresponde a un id renderizado en la lista", () => {
    const fragmento = fragmentoDelEnlace(renderNotices());

    expect(renderList()).toContain(`id="${fragmento}"`);
  });

  it("señala la fila de ESE pendiente y no la de otro", () => {
    const fragmento = fragmentoDelEnlace(renderNotices());
    const html = renderList([
      pending({ id: "otro-pendiente" }),
      pending({ id: PENDING_ID }),
    ]);

    expect(html).toContain(`id="${fragmento}"`);
    expect(fragmento).toContain(PENDING_ID);
    expect(fragmento).not.toContain("otro-pendiente");
  });

  it("va a Revisión de pendientes, no a la pantalla de captura", () => {
    const html = renderNotices();

    expect(html).toContain('href="/revision-pendientes#');
    expect(html).not.toContain('href="/pendientes');
  });

  // El ancla es inútil si la fila queda tapada por el topbar sticky (h-16):
  // se navega, no se ve nada moverse, y el síntoma es idéntico al del defecto
  // original.
  it("la fila deja aire para el topbar sticky", () => {
    expect(renderList()).toContain("scroll-mt-20");
  });
});
