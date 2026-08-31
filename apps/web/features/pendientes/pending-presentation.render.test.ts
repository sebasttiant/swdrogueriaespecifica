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
import { NO_PRESENTATION_LABEL } from "./presentation";

// --------------------------------------------------------------------------
// La presentación en REVISIÓN DE PENDIENTES.
//
// Se captura en Pendientes y se CONSULTA durante todo el resto del proceso.
// Acá es informativa: no se edita, porque el catálogo es compartido y esta es
// la mesa de trabajo, no la pantalla de captura.
//
// Los DOS orígenes leen el mismo campo, y estas pruebas lo fijan para que nadie
// ramifique por origen más adelante:
//
//   producto del catálogo  ->  `product.unit`
//   producto manual        ->  `product.unit` también: lo que el vendedor
//                              escribió en `manualUnit` se guardó ahí al crear
//                              el producto (ver `schema.ts`).
//
// `PendingCompactList` pinta la vista de TARJETAS y la de TABLA en el mismo
// render, así que dos ocurrencias significa "aparece en las dos".
// --------------------------------------------------------------------------

function pending(overrides: Partial<PendingListItem> = {}): PendingListItem {
  return {
    id: "pend-1",
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
    createdAt: new Date("2026-08-30T10:00:00.000Z"),
    deliveredQuantity: 0,
    cancelledQuantity: 0,
    identitySkippedReason: null,
    requestedLaboratory: null,
    product: {
      id: "prod-1",
      name: "Lantus Solostar",
      code: "LAN-1",
      unit: "Lapicera",
      orionCode: "7702001234567",
    },
    ...overrides,
  };
}

/** Un producto que nació manual: su presentación viaja en `product.unit`. */
function manual(unit: string): PendingListItem {
  return pending({
    id: "pend-manual",
    product: {
      id: "prod-manual",
      name: "Jarabe de la marca nueva",
      code: "PROV-nuevo",
      unit,
      orionCode: null,
    },
  });
}

function renderCompact(items: PendingListItem[]): string {
  return renderToStaticMarkup(
    createElement(PendingCompactList, {
      items,
      canOrder: false,
      nextCursor: null,
      pageHref: (cursor: string) => `?cursor=${cursor}`,
    }),
  );
}

function renderDetalle(items: PendingListItem[]): string {
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

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
});

describe("Revisión · presentación de un producto del CATÁLOGO", () => {
  it("aparece en tarjetas y en tabla", () => {
    const html = renderCompact([pending()]);

    expect(countOccurrences(html, "Presentación: Lapicera")).toBe(2);
  });

  it("aparece en el detalle, que es lo que usa Revisión de pendientes", () => {
    const html = renderDetalle([pending()]);

    expect(html).toContain("Presentación: Lapicera");
  });

  // Informativa: se lee, no se toca. Si acá hubiera un campo, cualquier rol con
  // acceso a Revisión podría alterar un dato compartido del catálogo.
  it("es informativa: no hay ningún campo para editarla", () => {
    for (const html of [renderCompact([pending()]), renderDetalle([pending()])]) {
      expect(html).not.toContain('name="unit"');
      expect(html).not.toContain('name="manualUnit"');
      expect(html).not.toContain('name="presentation"');
    }
  });
});

describe("Revisión · presentación de un producto MANUAL", () => {
  it("muestra lo que el vendedor escribió al crearlo", () => {
    const html = renderCompact([manual("Sobre")]);

    expect(countOccurrences(html, "Presentación: Sobre")).toBe(2);
  });

  it("también en el detalle", () => {
    expect(renderDetalle([manual("Sobre")])).toContain("Presentación: Sobre");
  });

  // El mismo campo para los dos orígenes: no hay una rama para catálogo y otra
  // para manual, y esta prueba existe para que no aparezca.
  it("se lee igual que la de un producto del catálogo", () => {
    const html = renderDetalle([pending(), manual("Blíster")]);

    expect(html).toContain("Presentación: Lapicera");
    expect(html).toContain("Presentación: Blíster");
  });
});

describe("Revisión · producto SIN presentación", () => {
  it("lo dice con palabras en las dos vistas compactas", () => {
    const html = renderCompact([manual("")]);

    expect(countOccurrences(html, `Presentación: ${NO_PRESENTATION_LABEL}`)).toBe(2);
  });

  it("y en el detalle", () => {
    expect(renderDetalle([manual("")])).toContain(
      `Presentación: ${NO_PRESENTATION_LABEL}`,
    );
  });

  // El renglón se muestra SIEMPRE: un hueco en blanco no distingue "el producto
  // no la tiene" de "el dato no llegó a la pantalla".
  it("nunca desaparece el renglón", () => {
    for (const unidad of ["", "   "]) {
      expect(renderDetalle([manual(unidad)])).toContain("Presentación:");
    }
  });
});

describe("Revisión · no rompe lo que ya se mostraba", () => {
  it("la cantidad sigue en su lugar", () => {
    expect(renderDetalle([pending()])).toContain("2 Lapicera");
  });

  it("el laboratorio pedido sigue siendo una línea aparte", () => {
    const html = renderDetalle([
      pending({ requestedLaboratory: { id: "lab-1", name: "Sanofi" } }),
    ]);

    expect(html).toContain("Lab: Sanofi");
    expect(html).toContain("Presentación: Lapicera");
  });

  // Sin columnas nuevas: la tabla se mira desde el celular y una columna más
  // obliga a scroll horizontal. La presentación va DENTRO de la celda del
  // producto, como el laboratorio y el aviso de SKU.
  it("no agrega una columna a la tabla", () => {
    const html = renderCompact([pending()]);
    const encabezado = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));

    expect(encabezado).not.toContain("Presentación");
  });
});
