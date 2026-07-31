import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/pending.actions", () => ({
  updatePendingManagementStatusAction: vi.fn(),
  contactPendingAction: vi.fn(),
  invoicePendingAction: vi.fn(),
  deliverPendingAction: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PendingListItem } from "@/server/repositories/pending.repository";

import { PendingCompactList } from "./pending-compact-list";

function pending(overrides: Partial<PendingListItem> = {}): PendingListItem {
  return {
    id: "pend-1",
    quantity: 10,
    status: "PENDIENTE",
    promisedAt: new Date("2026-08-10T18:00:00.000Z"),
    customerName: "Ana Pérez",
    note: null,
    customerPhone: "3001234567",
    customerAddress: "Calle 10 #20-30",
    createdBy: { id: "u-1", name: "Juan Esteban" },
    zone: "Belén",
    totalAmount: 50000,
    paidAmount: 20000,
    createdAt: new Date("2026-07-09T10:00:00.000Z"),
    deliveredQuantity: 0,
    product: { id: "prod-1", name: "Paracetamol", code: "P-001", unit: "unidad" },
    ...overrides,
  };
}

function render(
  items: PendingListItem[],
  canOrder = true,
  nextCursor: string | null = null,
  capabilities: { canDeliver?: boolean; canContactOrInvoice?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(PendingCompactList, {
      items,
      canOrder,
      canDeliver: capabilities.canDeliver,
      canContactOrInvoice: capabilities.canContactOrInvoice,
      nextCursor,
      pageHref: (cursor) => `/pendientes?cursor=${encodeURIComponent(cursor)}&view=lista`,
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

// --------------------------------------------------------------------------
// Lo que el gerente pidió en la reunión del 2026-07-30: "me falta que lo muestre
// en listado... para que Andrés y don Guillermo sepan quién ha pedido qué, y que
// le puedan colocar el okay".
// --------------------------------------------------------------------------
describe("PendingCompactList", () => {
  it("muestra producto, cantidad, vendedor y fecha de un vistazo", () => {
    const html = render([pending()]);

    expect(html).toContain("Paracetamol");
    expect(html).toContain("10");
    // Quién lo pidió: es el pedido textual del gerente.
    expect(countOccurrences(html, "Juan Esteban")).toBe(2); // móvil + tabla
  });

  it("rotula las columnas del listado que pidió gerencia", () => {
    const html = render([pending()]);

    for (const header of ["Producto", "Cantidad", "Vendedor", "Para", "Estado"]) {
      expect(html).toMatch(new RegExp(`<th[^>]*>${header}</th>`));
    }
  });

  // ESTA ES LA RAZÓN DE SER DE LA VISTA. Quien compra no necesita saber a qué
  // cliente va el producto: necesita ver qué conseguir. Mostrar cliente,
  // teléfono y dirección acá convertiría el listado en la pared de texto que
  // ya es la vista detallada, y encima expondría datos del cliente a quien no
  // los precisa para esta tarea.
  it("NO muestra datos del cliente: es la vista de compras", () => {
    const html = render([pending()]);

    expect(html).not.toContain("Ana Pérez");
    expect(html).not.toContain("3001234567");
    expect(html).not.toContain("Calle 10 #20-30");
    expect(html).not.toContain("Belén");
  });

  it("ofrece el okay de un toque a la autoridad de compras", () => {
    const html = render([pending()], true);

    expect(html).toContain("Ya lo pedí");
    expect(html).toContain("Ya lo pedí");
    // El estado viaja fijo: el gerente no elige de una lista, solo confirma.
    expect(html).toContain('name="status" value="SOLICITADO"');
  });

  it("no ofrece el okay a quien no es autoridad de compras", () => {
    const html = render([pending()], false);

    expect(html).not.toContain("Ya lo pedí");
  });

  // Un pendiente que ya tiene estado de gestión necesita el selector completo
  // (en búsqueda, cotizando, agotado), no este atajo.
  it("no ofrece el okay sobre un pendiente ya gestionado", () => {
    const html = render([pending({ status: "SOLICITADO", purchaseStatus: "SOLICITADO" })], true);

    expect(html).not.toContain("Ya lo pedí");
    expect(html).toContain("Solicitado");
  });

  it.each(["PARCIAL", "ENTREGADO", "CANCELADO"] as const)(
    "no ofrece el okay sobre un estado no elegible: %s",
    (status) => {
      expect(render([pending({ status })], true)).not.toContain("Ya lo pedí");
    },
  );

  it.each([
    ["PARCIAL", "Entrega parcial"],
    ["ENTREGADO", "Entregado"],
    ["CANCELADO", "Cancelado"],
  ] as const)("does not label %s as 'Por pedir'", (status, label) => {
    const html = render([pending({ status })], true);

    expect(html).toContain(label);
    expect(html).not.toContain("Por pedir");
  });

  // "Por pedir" dice qué hacer; "Pendiente" solo nombra un estado.
  it("dice 'Por pedir' en lo que todavía espera decisión", () => {
    const html = render([pending()]);

    expect(html).toContain("Por pedir");
  });

  // La urgencia se comunica con texto y color, nunca solo con color: se lee en
  // un celular, muchas veces al sol.
  it("marca la urgencia con palabras, no solo con color", () => {
    const html = render([
      pending({ promisedAt: new Date("2020-01-01T00:00:00.000Z") }),
    ]);

    expect(html).toContain("Vencido");
  });

  it("muestra un vacío claro cuando no hay nada que comprar", () => {
    expect(render([])).toContain("No hay pendientes");
  });

  it("no rompe con un pendiente sin vendedor registrado", () => {
    const html = render([pending({ createdBy: null })]);

    expect(html).toContain("Sin vendedor");
  });

  it("preserva el formato compacto al pasar a la siguiente página", () => {
    const html = render([pending()], true, "next cursor");

    expect(html).toContain("Ver más");
    expect(html).toContain("/pendientes?cursor=next%20cursor&amp;view=lista");
  });

  it("posts the observed purchase status for the quick-order compare-and-set", () => {
    expect(render([pending()])).toContain('name="expectedStatus" value="POR_PEDIR"');
  });

  it("uses purchaseStatus, not legacy status, for management label and action", () => {
    const html = render([pending({ status: "SOLICITADO", purchaseStatus: "POR_PEDIR" })]);

    expect(html).toContain("Por pedir");
    expect(html).toContain("Ya lo pedí");
  });

  it("shows seller contact actions in the desktop table without purchase authority", () => {
    const html = render(
      [pending({ customerStatus: "POR_CONTACTAR", inventoryReadyQuantity: 10, purchaseStatus: "SOLICITADO" })],
      false,
      null,
      { canContactOrInvoice: true },
    );

    expect(countOccurrences(html, "Contactar cliente")).toBe(2);
    expect(html).not.toContain("Ya lo pedí");
  });

  it("shows seller invoice actions in the desktop table", () => {
    const html = render(
      [pending({ customerStatus: "CONTACTADO", inventoryReadyQuantity: 10, invoicedQuantity: 0, purchaseStatus: "SOLICITADO" })],
      false,
      null,
      { canContactOrInvoice: true, canDeliver: true },
    );

    expect(countOccurrences(html, "Marcar facturado")).toBe(2);
  });

  it("shows seller delivery actions in the desktop table", () => {
    const html = render(
      [pending({ customerStatus: "FACTURADO", inventoryReadyQuantity: 10, invoicedQuantity: 10, purchaseStatus: "SOLICITADO" })],
      false,
      null,
      { canDeliver: true },
    );

    expect(countOccurrences(html, "Entregar disponible: 10")).toBe(2);
  });

  // El vendedor no vigila la bodega: la fila tiene que avisarle. Sin este aviso
  // el pendiente se ve igual antes y después de que llegue su mercancía.
  it("avisa que la mercancía llegó y ya se puede facturar", () => {
    const html = render(
      [pending({ customerStatus: "CONTACTADO", inventoryReadyQuantity: 10, invoicedQuantity: 0 })],
      false,
      null,
      { canContactOrInvoice: true },
    );

    expect(countOccurrences(html, "Disponible para facturar")).toBe(2);
  });

  it("distingue la llegada parcial de la completa", () => {
    const html = render(
      [pending({ quantity: 10, customerStatus: "CONTACTADO", inventoryReadyQuantity: 6, invoicedQuantity: 0 })],
      false,
      null,
      { canContactOrInvoice: true },
    );

    expect(countOccurrences(html, "Disponible para facturar: 6 de 10")).toBe(2);
  });

  it("no avisa disponibilidad sobre un pendiente ya cerrado", () => {
    const html = render([
      pending({
        status: "ENTREGADO",
        customerStatus: "ENTREGADO",
        inventoryReadyQuantity: 10,
        invoicedQuantity: 10,
        deliveredQuantity: 10,
      }),
    ]);

    expect(html).not.toContain("Disponible para facturar");
    expect(html).not.toContain("listo para entregar");
  });
});
