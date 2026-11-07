import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/pending.actions", () => ({
  deliverPendingAction: vi.fn(),
  cancelPendingAction: vi.fn(),
  contactPendingAction: vi.fn(),
  invoicePendingAction: vi.fn(),
  resolveWaitlistDecisionAction: vi.fn(),
  updatePendingManagementStatusAction: vi.fn(),
  updatePendingPurchaseDepositAction: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { can, USER_ROLES } from "@/lib/auth/permissions";
import type { SessionRole } from "@/lib/auth/session";
import type { PendingListItem } from "@/server/repositories/pending.repository";

import { pendingViewerFor } from "./fulfillment-notice";
import { PendingCompactList } from "./pending-compact-list";
import { PendingList } from "./pending-list";

// --------------------------------------------------------------------------
// Controles por fila, con el lector REAL de cada rol (`pendingViewerFor`).
//
// Desde que todos leen la cola entera (2026-09-30), el vendedor y bodega ven
// filas ajenas. Sobre esas se les ofrece CORREGIR —`canEditAllPendings`— y
// nada más: entregar, cancelar y responder la lista de espera siguen acotados a
// lo propio por `canManageAllPendings`. El servidor vuelve a decidir todo; esto
// solo evita ofrecer un gesto que va a ser rechazado.
// --------------------------------------------------------------------------

const ME = "user-me";

function pending(overrides: Partial<PendingListItem> = {}): PendingListItem {
  return {
    id: "pend-1",
    quantity: 10,
    status: "PENDIENTE",
    promisedAt: new Date("2026-08-10T18:00:00.000Z"),
    customerName: null,
    note: null,
    customerPhone: null,
    customerAddress: null,
    createdBy: { id: "user-other", name: "Otra vendedora" },
    zone: null,
    totalAmount: null,
    paidAmount: 0,
    paymentMethod: null,
    createdAt: new Date("2026-07-09T10:00:00.000Z"),
    deliveredQuantity: 0,
    cancelledQuantity: 0,
    identitySkippedReason: null,
    requestedLaboratory: null,
    // Facturado y cargado: el caso en que entregar está disponible.
    customerStatus: "FACTURADO",
    inventoryReadyQuantity: 10,
    invoicedQuantity: 10,
    product: { id: "prod-1", name: "Paracetamol", code: "P-001", unit: "unidad", orionCode: null },
    ...overrides,
  };
}

const own = (overrides: Partial<PendingListItem> = {}) =>
  pending({ createdBy: { id: ME, name: "Yo" }, ...overrides });

function compact(role: SessionRole, items: PendingListItem[]): string {
  return renderToStaticMarkup(
    createElement(PendingCompactList, {
      items,
      canOrder: false,
      canDeliver: can(role, "canDeliverPendings"),
      canCancel: can(role, "canCancelPendings"),
      canEdit: can(role, "canCreatePendientes"),
      viewer: pendingViewerFor(role, ME),
      nextCursor: null,
      pageHref: () => "",
    }),
  );
}

function detail(role: SessionRole, items: PendingListItem[]): string {
  return renderToStaticMarkup(
    createElement(PendingList, {
      items,
      nextCursor: null,
      canDeliver: can(role, "canDeliverPendings"),
      canCancel: can(role, "canCancelPendings"),
      canManageStatus: false,
      canWriteObservation: false,
      viewer: pendingViewerFor(role, ME),
      scope: "active",
      pageHref: () => "",
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
});

describe("controles por fila · lista compacta", () => {
  it("OPERADOR sobre una fila AJENA: solo Corregir", () => {
    const html = compact("OPERADOR", [pending()]);

    expect(html).toContain("Corregir");
    expect(html).not.toContain("Entregar disponible");
    expect(html).not.toContain("Cancelar");
    expect(html).not.toContain("Lo espera");
  });

  // Bodega dejó de comportarse como el vendedor el 2026-11-06: gerencia le abrió
  // la cancelación sobre cualquier fila porque es quien ve llegar la mercadería
  // y sabe cuándo un pedido ya no tiene sentido. Entrega y facturación NO se
  // abrieron, y eso es lo que estas dos expectativas negativas cuidan.
  it("BODEGA sobre una fila AJENA: corrige y cancela, no entrega ni factura", () => {
    const html = compact("BODEGA", [pending()]);

    expect(html).toContain("Corregir");
    expect(html).toContain("Cancelar");
    expect(html).not.toContain("Entregar disponible");
    expect(html).not.toContain("Lo espera");
  });

  it.each(["OPERADOR", "BODEGA"] as const)(
    "%s sobre una fila PROPIA: entrega, cancela, responde y corrige",
    (role) => {
      const html = compact(role, [own()]);

      expect(html).toContain("Entregar disponible");
      expect(html).toContain("Cancelar");
      expect(html).toContain("Lo espera");
      expect(html).toContain("Corregir");
    },
  );

  it.each(["SUPERVISOR", "ADMIN", "SUPERADMIN"] as const)(
    "%s sobre una fila ajena: todos los controles",
    (role) => {
      const html = compact(role, [pending()]);

      expect(html).toContain("Entregar disponible");
      expect(html).toContain("Cancelar");
      expect(html).toContain("Lo espera");
      expect(html).toContain("Corregir");
    },
  );

  // Quien tiene `canEditAllPendings` corrige las veces que haga falta: la
  // marca de la corrección única ya no le esconde el enlace.
  it.each(USER_ROLES)("%s: una corrección previa no esconde Corregir", (role) => {
    const html = compact(role, [own({ sellerEditedAt: new Date("2026-07-10T10:00:00.000Z") })]);

    expect(html).toContain("Corregir");
  });
});

describe("controles por fila · vista detallada", () => {
  it("OPERADOR no ve entregar ni cancelar sobre una fila ajena, sí sobre la propia", () => {
    const foreign = detail("OPERADOR", [pending()]);
    expect(foreign).not.toContain("Entregar disponible");
    expect(foreign).not.toContain("Cancelar");

    const mine = detail("OPERADOR", [own()]);
    expect(mine).toContain("Entregar disponible");
    expect(mine).toContain("Cancelar");
  });

  it("BODEGA cancela cualquier fila y entrega solo la propia", () => {
    const foreign = detail("BODEGA", [pending()]);
    expect(foreign).toContain("Cancelar");
    expect(foreign).not.toContain("Entregar disponible");

    const mine = detail("BODEGA", [own()]);
    expect(mine).toContain("Entregar disponible");
    expect(mine).toContain("Cancelar");
  });

  it("SUPERVISOR entrega y cancela cualquier fila", () => {
    const html = detail("SUPERVISOR", [pending()]);

    expect(html).toContain("Entregar disponible");
    expect(html).toContain("Cancelar");
  });
});
