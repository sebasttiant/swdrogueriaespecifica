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
import { pendingAnchorId } from "./pending-anchor";
import { noAuthorityViewer } from "./pending-viewer.fixture";

// --------------------------------------------------------------------------
// Un ancla, UNA sola vez en el documento.
//
// `PendingCompactList` pinta las DOS vistas —tarjetas y tabla— en el MISMO
// documento y oculta una con CSS (`lg:hidden` / `hidden lg:block`). Poner el
// `id` en las dos deja dos elementos con el mismo identificador: HTML
// inválido, y el navegador salta al PRIMERO, que en escritorio es la tarjeta
// OCULTA. Saltar a un elemento `display:none` no hace nada — exactamente el
// síntoma del defecto que el ancla vino a arreglar.
//
// Por eso el ancla vive solo en `PendingList`, que pinta una variante por fila.
// Estas pruebas lo fijan para que nadie la reponga del otro lado sin darse
// cuenta.
// --------------------------------------------------------------------------

function pending(id: string): PendingListItem {
  return {
    id,
    quantity: 2,
    status: "PENDIENTE",
    promisedAt: new Date("2026-08-31T18:00:00.000Z"),
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
    identitySkippedReason: null,
    requestedLaboratory: null,
    product: {
      id: `prod-${id}`,
      name: "Lantus Solostar",
      code: "LAN-1",
      unit: "Lapicera",
      orionCode: "7702001234567",
    },
  };
}

/** Cuántas veces aparece cada `id=` en el HTML. */
function idCounts(html: string): Map<string, number> {
  const cuentas = new Map<string, number>();
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
    const id = match[1]!;
    cuentas.set(id, (cuentas.get(id) ?? 0) + 1);
  }
  return cuentas;
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
});

describe("lista compacta · las dos vistas conviven en el documento", () => {
  const html = () =>
    renderToStaticMarkup(
      createElement(PendingCompactList, {
      viewer: noAuthorityViewer,
        items: [pending("p1"), pending("p2")],
        canOrder: false,
        nextCursor: null,
        pageHref: (c: string) => `?cursor=${c}`,
      }),
    );

  // Si esto deja de ser cierto, el resto del razonamiento cambia.
  it("efectivamente pinta las dos: móvil y tabla", () => {
    expect(html().split("Lantus Solostar").length - 1).toBe(4); // 2 filas × 2 vistas
  });

  it("NO pone anclas de pendiente: se duplicarían", () => {
    const marcado = html();

    expect(marcado).not.toContain(`id="${pendingAnchorId("p1")}"`);
    expect(marcado).not.toContain(`id="${pendingAnchorId("p2")}"`);
  });

  it("ningún id se repite en el documento", () => {
    const repetidos = [...idCounts(html())].filter(([, n]) => n > 1);

    expect(repetidos, `ids duplicados: ${JSON.stringify(repetidos)}`).toEqual([]);
  });
});

describe("lista de detalle · una variante por fila, el ancla vive acá", () => {
  const html = (items: PendingListItem[]) =>
    renderToStaticMarkup(
      createElement(PendingList, {
      viewer: noAuthorityViewer,
        items,
        nextCursor: null,
        canDeliver: true,
        canCancel: true,
        canManageStatus: false,
        scope: "active" as const,
        pageHref: () => "",
      }),
    );

  it("pone el ancla de cada pendiente exactamente una vez", () => {
    const cuentas = idCounts(html([pending("p1"), pending("p2")]));

    expect(cuentas.get(pendingAnchorId("p1"))).toBe(1);
    expect(cuentas.get(pendingAnchorId("p2"))).toBe(1);
  });

  it("ningún id se repite, ni siquiera con muchas filas", () => {
    const items = Array.from({ length: 25 }, (_, i) => pending(`p${i}`));
    const repetidos = [...idCounts(html(items))].filter(([, n]) => n > 1);

    expect(repetidos, `ids duplicados: ${JSON.stringify(repetidos)}`).toEqual([]);
  });
});
