import { describe, expect, it } from "vitest";

import type { PendingListItem } from "@/server/repositories/pending.repository";

import {
  arrivalNotice,
  canInvoiceWithoutStock,
  fulfillmentNotice,
  invoiceableQuantity,
  invoiceAffordance,
  pendingStateTone,
} from "./fulfillment-notice";
import { globalViewer, noAuthorityViewer, OWNER_ID, ownerViewer } from "./pending-viewer.fixture";

function pending(overrides: Partial<PendingListItem> = {}): PendingListItem {
  return {
    id: "pend-1",
    quantity: 10,
    status: "PENDIENTE",
    customerStatus: "POR_CONTACTAR",
    promisedAt: new Date("2099-08-31T18:00:00.000Z"),
    customerName: null,
    note: null,
    customerPhone: null,
    customerAddress: null,
    createdBy: { id: OWNER_ID, name: "Vendedora" },
    zone: null,
    totalAmount: null,
    paidAmount: 0,
    paymentMethod: null,
    createdAt: new Date("2026-08-30T10:00:00.000Z"),
    deliveredQuantity: 0,
    cancelledQuantity: 0,
    inventoryReadyQuantity: 0,
    invoicedQuantity: 0,
    identitySkippedReason: null,
    requestedLaboratory: null,
    product: {
      id: "prod-1",
      name: "Producto",
      code: "P-1",
      unit: "Caja",
      orionCode: null,
    },
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// UNA sola regla de "listo para facturar": lo que se puede facturar AHORA es lo
// cargado que todavía no se facturó, acotado a lo pedido. Es la misma cuenta que
// valida `invoicePending` en el servidor; el aviso, el botón, el filtro y el
// color la leen de acá.
// --------------------------------------------------------------------------
describe("invoiceableQuantity · la regla única", () => {
  it("todo cargado y nada facturado: se factura el pedido entero", () => {
    expect(invoiceableQuantity(pending({ inventoryReadyQuantity: 10 }))).toBe(10);
  });

  it("llegada parcial: se factura solo lo cargado", () => {
    expect(invoiceableQuantity(pending({ inventoryReadyQuantity: 5 }))).toBe(5);
  });

  // `invoicePending` escribe FACTURADO en CADA factura, también en la parcial.
  // Por eso la regla no puede mirar `customerStatus === "FACTURADO"`.
  it("facturado a medias con más carga: queda lo cargado sin facturar", () => {
    expect(
      invoiceableQuantity(
        pending({ customerStatus: "FACTURADO", invoicedQuantity: 4, inventoryReadyQuantity: 10 }),
      ),
    ).toBe(6);
  });

  it("todo lo cargado ya se facturó: no queda nada", () => {
    expect(
      invoiceableQuantity(
        pending({ customerStatus: "FACTURADO", invoicedQuantity: 5, inventoryReadyQuantity: 5 }),
      ),
    ).toBe(0);
  });

  it("sin carga: cero", () => {
    expect(invoiceableQuantity(pending())).toBe(0);
  });

  it.each(["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] as const)(
    "el estado terminal %s no ofrece nada aunque haya carga",
    (status) => {
      expect(invoiceableQuantity(pending({ status, inventoryReadyQuantity: 10 }))).toBe(0);
    },
  );

  it.each(["ENTREGADO", "CANCELADO"] as const)(
    "el cliente terminal %s no ofrece nada aunque haya carga",
    (customerStatus) => {
      expect(
        invoiceableQuantity(pending({ customerStatus, inventoryReadyQuantity: 10 })),
      ).toBe(0);
    },
  );
});

describe("fulfillmentNotice · listo para facturar primero", () => {
  it("dice solo 'Listo para facturar' cuando se factura el pedido entero", () => {
    expect(fulfillmentNotice(pending({ inventoryReadyQuantity: 10 }))).toEqual({
      label: "Listo para facturar",
      tone: "warning",
    });
  });

  // Antes caía en rojo "Sin stock suficiente": el vendedor veía un pedido que
  // podía facturar en parte como si no pudiera hacer nada.
  it("una llegada parcial sin entregas es amarilla, con X de Y", () => {
    expect(fulfillmentNotice(pending({ inventoryReadyQuantity: 5 }))).toEqual({
      label: "Listo para facturar: 5 de 10",
      tone: "warning",
    });
  });

  it("un pendiente facturado a medias con carga nueva vuelve a estar listo", () => {
    expect(
      fulfillmentNotice(
        pending({ customerStatus: "FACTURADO", invoicedQuantity: 4, inventoryReadyQuantity: 10 }),
      ),
    ).toEqual({ label: "Listo para facturar: 6 de 10", tone: "warning" });
  });

  it("sale del amarillo cuando lo cargado ya se facturó", () => {
    const notice = fulfillmentNotice(
      pending({ customerStatus: "FACTURADO", invoicedQuantity: 10, inventoryReadyQuantity: 10 }),
    );

    expect(notice).toEqual({ label: "Listo para entregar", tone: "primary" });
  });

  it("sin carga sigue diciendo Sin stock", () => {
    expect(fulfillmentNotice(pending())).toEqual({ label: "Sin stock", tone: "danger" });
  });

  // El rojo parcial sigue existiendo cuando NO hay nada que facturar.
  it("cobertura parcial ya facturada sigue en rojo parcial", () => {
    expect(
      fulfillmentNotice(
        pending({
          status: "PARCIAL",
          customerStatus: "FACTURADO",
          deliveredQuantity: 4,
          invoicedQuantity: 7,
          inventoryReadyQuantity: 7,
        }),
      ),
    ).toEqual({
      label: "Sin stock suficiente · 3 de 6 restantes disponibles",
      tone: "danger",
    });
  });

  it("calla en un pendiente terminal", () => {
    expect(
      fulfillmentNotice(pending({ status: "ENTREGADO", inventoryReadyQuantity: 10 })),
    ).toBeNull();
  });
});

describe("invoiceAffordance · misma X, gateada por alcance", () => {
  const listo = pending({ customerStatus: "FACTURADO", invoicedQuantity: 4, inventoryReadyQuantity: 10 });

  it("usa la MISMA cantidad que el aviso", () => {
    expect(invoiceAffordance(listo, globalViewer())).toEqual({
      canInvoice: true,
      invoiceable: invoiceableQuantity(listo),
    });
  });

  it("el dueño con alcance propio factura su fila", () => {
    expect(invoiceAffordance(listo, ownerViewer()).canInvoice).toBe(true);
  });

  it("el alcance propio no factura la fila de otro", () => {
    expect(invoiceAffordance(listo, ownerViewer("otro-vendedor"))).toEqual({
      canInvoice: false,
      invoiceable: 6,
    });
  });

  it("sin autoridad no se ofrece el botón", () => {
    expect(invoiceAffordance(listo, noAuthorityViewer).canInvoice).toBe(false);
  });

  it("con X = 0 no se ofrece aunque haya autoridad", () => {
    expect(
      invoiceAffordance(pending({ invoicedQuantity: 5, inventoryReadyQuantity: 5 }), globalViewer()),
    ).toEqual({ canInvoice: false, invoiceable: 0 });
  });

  it("terminal: nada", () => {
    expect(
      invoiceAffordance(pending({ status: "CANCELADO", inventoryReadyQuantity: 10 }), globalViewer()),
    ).toEqual({ canInvoice: false, invoiceable: 0 });
  });
});

// --------------------------------------------------------------------------
// U5 — a quién se le muestra el formulario de facturar aunque no haya stock.
// Es aditivo: la regla de "listo para facturar" (U4) no se toca.
// --------------------------------------------------------------------------
describe("canInvoiceWithoutStock", () => {
  const sinCarga = pending();

  it("alcance global, sin carga y con saldo: sí", () => {
    expect(canInvoiceWithoutStock(sinCarga, globalViewer())).toBe(true);
  });

  it("alcance propio sobre su fila: sí", () => {
    expect(canInvoiceWithoutStock(sinCarga, ownerViewer())).toBe(true);
  });

  it("alcance propio sobre la fila de otro: no", () => {
    expect(canInvoiceWithoutStock(sinCarga, ownerViewer("otro-vendedor"))).toBe(false);
  });

  it("sin autoridad: no", () => {
    expect(canInvoiceWithoutStock(sinCarga, noAuthorityViewer)).toBe(false);
  });

  it("saldo en cero: no", () => {
    expect(
      canInvoiceWithoutStock(
        pending({ customerStatus: "FACTURADO", invoicedQuantity: 10 }),
        globalViewer(),
      ),
    ).toBe(false);
  });

  it("facturado a medias sin carga: queda saldo, sí", () => {
    expect(
      canInvoiceWithoutStock(
        pending({ customerStatus: "FACTURADO", invoicedQuantity: 4 }),
        globalViewer(),
      ),
    ).toBe(true);
  });

  it.each([
    { status: "ENTREGADO" as const },
    { status: "CANCELADO" as const },
    { status: "CLOSED_PARTIAL" as const },
    { customerStatus: "ENTREGADO" as const },
    { customerStatus: "CANCELADO" as const },
  ])("terminal (%o): no", (overrides) => {
    expect(canInvoiceWithoutStock(pending(overrides), globalViewer())).toBe(false);
  });

  it("no cambia la regla de U4 sobre la misma fila sin carga", () => {
    expect(invoiceableQuantity(sinCarga)).toBe(0);
    expect(invoiceAffordance(sinCarga, globalViewer())).toEqual({ canInvoice: false, invoiceable: 0 });
    expect(fulfillmentNotice(sinCarga)).toEqual({ label: "Sin stock", tone: "danger" });
    expect(pendingStateTone(sinCarga)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// El color de la tarjeta: la ACCIÓN posible manda. Amarillo si se puede
// facturar, aunque gerencia lo haya marcado agotado; rojo solo si no se puede
// facturar y está agotado.
// --------------------------------------------------------------------------
describe("pendingStateTone", () => {
  it("listo para facturar es amarillo", () => {
    expect(pendingStateTone(pending({ inventoryReadyQuantity: 3 }))).toBe("ready");
  });

  it("el amarillo gana aunque compras lo marcó AGOTADO", () => {
    expect(
      pendingStateTone(pending({ purchaseStatus: "AGOTADO", inventoryReadyQuantity: 3 })),
    ).toBe("ready");
  });

  it("agotado sin nada que facturar es rojo", () => {
    expect(pendingStateTone(pending({ purchaseStatus: "AGOTADO" }))).toBe("soldOut");
  });

  // El AGOTADO de `status` es legado: el rojo lee la columna viva.
  it("el AGOTADO legado de status no pinta rojo", () => {
    expect(pendingStateTone(pending({ status: "AGOTADO", purchaseStatus: "POR_PEDIR" }))).toBeNull();
  });

  it("ni listo ni agotado: sin color", () => {
    expect(pendingStateTone(pending({ purchaseStatus: "SOLICITADO" }))).toBeNull();
  });

  it.each([
    { status: "ENTREGADO" as const },
    { status: "CLOSED_PARTIAL" as const },
    { customerStatus: "CANCELADO" as const },
  ])("terminal (%o) no lleva color aunque esté agotado", (overrides) => {
    expect(
      pendingStateTone(pending({ purchaseStatus: "AGOTADO", inventoryReadyQuantity: 3, ...overrides })),
    ).toBeNull();
  });
});

// --------------------------------------------------------------------------
// La llegada a bodega, dicha con palabras. Es independiente de lo facturable:
// una fila puede haber llegado y además estar lista para facturar.
// --------------------------------------------------------------------------
describe("arrivalNotice", () => {
  it.each([
    ["LLEGO_BODEGA", "Ya llegó a bodega"],
    ["DISPONIBLE_COMPLETO", "Ya llegó a bodega"],
    ["DISPONIBLE_PARCIAL", "Ya llegó parte a bodega"],
  ] as const)("%s dice %s", (availabilityStatus, label) => {
    expect(arrivalNotice(pending({ availabilityStatus }))).toBe(label);
  });

  it("todavía esperando: nada", () => {
    expect(arrivalNotice(pending({ availabilityStatus: "ESPERANDO" }))).toBeNull();
    expect(arrivalNotice(pending())).toBeNull();
  });

  it.each([
    { status: "ENTREGADO" as const },
    { status: "CANCELADO" as const },
    { status: "CLOSED_PARTIAL" as const },
    { customerStatus: "ENTREGADO" as const },
    { customerStatus: "CANCELADO" as const },
  ])("terminal (%o): nada aunque haya llegado", (overrides) => {
    expect(
      arrivalNotice(pending({ availabilityStatus: "DISPONIBLE_COMPLETO", ...overrides })),
    ).toBeNull();
  });

  it("convive con listo para facturar: se dicen las dos cosas", () => {
    const fila = pending({ availabilityStatus: "DISPONIBLE_COMPLETO", inventoryReadyQuantity: 10 });

    expect(arrivalNotice(fila)).toBe("Ya llegó a bodega");
    expect(fulfillmentNotice(fila)).toEqual({ label: "Listo para facturar", tone: "warning" });
  });
});
