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
  contactPendingAction: vi.fn(),
  invoicePendingAction: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PendingListItem } from "@/server/repositories/pending.repository";

import { PendingCompactList } from "./pending-compact-list";
import { PendingList } from "./pending-list";
import { globalViewer } from "./pending-viewer.fixture";

function pending(overrides: Partial<PendingListItem> = {}): PendingListItem {
  return {
    id: "pend-1",
    quantity: 10,
    status: "PENDIENTE",
    promisedAt: new Date("2099-08-31T18:00:00.000Z"),
    customerName: null,
    note: null,
    customerPhone: null,
    customerAddress: null,
    createdBy: null,
    zone: null,
    totalAmount: null,
    paidAmount: 0,
    paymentMethod: null,
    createdAt: new Date("2026-08-30T10:00:00.000Z"),
    deliveredQuantity: 0,
    cancelledQuantity: 0,
    inventoryReadyQuantity: 0,
    identitySkippedReason: null,
    requestedLaboratory: null,
    product: {
      id: "prod-1",
      name: "Producto del catálogo",
      code: "CAT-1",
      unit: "Caja",
      orionCode: "7702001234567",
    },
    ...overrides,
  };
}

function renderDetail(item: PendingListItem): string {
  return renderToStaticMarkup(
    createElement(PendingList, {
      viewer: globalViewer(),
      items: [item],
      nextCursor: null,
      canDeliver: true,
      canCancel: true,
      canManageStatus: false,
       canWriteObservation: false,
      scope: "active" as const,
      pageHref: (cursor: string) => `?cursor=${cursor}`,
    }),
  );
}

function renderCompact(item: PendingListItem): string {
  return renderToStaticMarkup(
    createElement(PendingCompactList, {
      viewer: globalViewer(),
      items: [item],
      canOrder: false,
      nextCursor: null,
      pageHref: (cursor: string) => `?cursor=${cursor}`,
    }),
  );
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
});

describe("Revisión de pendientes · cobertura del remanente", () => {
  it("marca Sin stock para un producto existente con cobertura cero", () => {
    const html = renderDetail(pending({ purchaseStatus: "AGOTADO" }));

    expect(html).toMatch(/bg-danger\/10 text-danger[^>]*>Sin stock<\/span>/);
  });

  it("marca Sin stock para un producto provisional con cobertura cero", () => {
    const html = renderDetail(
      pending({
        product: {
          id: "prod-provisional",
          name: "Producto recién creado",
          code: "PROV-nuevo",
          unit: "Sobre",
          orionCode: null,
        },
      }),
    );

    expect(html).toContain(">Sin stock</span>");
  });

  // Regla única (U4): lo cargado y sin facturar SE PUEDE facturar, aunque no
  // cubra el pedido. Antes esta llegada parcial salía en rojo "Sin stock
  // suficiente" mientras el botón de facturar sí se ofrecía: dos reglas que se
  // contradecían sobre la misma fila.
  it("una cobertura parcial facturable dice cuánto se factura de cuánto", () => {
    const html = renderDetail(pending({ inventoryReadyQuantity: 4 }));

    expect(html).toContain("Listo para facturar: 4 de 10");
    expect(html).not.toContain("Sin stock");
  });

  it("conserva el aviso actual cuando hay cobertura suficiente", () => {
    const html = renderDetail(pending({ inventoryReadyQuantity: 10 }));

    expect(html).toContain("Listo para facturar");
    expect(html).not.toContain("Sin stock");
  });

  it("no deriva la falta de stock desde purchaseStatus AGOTADO", () => {
    const html = renderDetail(
      pending({ purchaseStatus: "AGOTADO", inventoryReadyQuantity: 10 }),
    );

    expect(html).not.toContain("Sin stock");
  });

  // Con lo cargado ya facturado no queda nada que facturar: el rojo parcial
  // sigue aplicando y descuenta lo entregado.
  it("descuenta lo entregado al comparar contra el remanente", () => {
    const html = renderDetail(
      pending({
        status: "PARCIAL",
        customerStatus: "FACTURADO",
        deliveredQuantity: 4,
        invoicedQuantity: 7,
        inventoryReadyQuantity: 7,
      }),
    );

    expect(html).toContain("Sin stock suficiente · 3 de 6 restantes disponibles");
  });

  it.each(["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] as const)(
    "no introduce avisos de stock en el estado terminal %s",
    (status) => {
      expect(renderDetail(pending({ status }))).not.toContain("Sin stock");
    },
  );

  it("mantiene la misma salida en la tarjeta móvil y la tabla de escritorio", () => {
    const label = "Listo para facturar: 4 de 10";

    expect(countOccurrences(renderCompact(pending({ inventoryReadyQuantity: 4 })), label)).toBe(2);
  });
});
