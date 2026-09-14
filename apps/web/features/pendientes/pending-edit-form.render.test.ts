import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hooks/use-action-state", () => ({
  useActionState: () => [{ error: null, ok: false }, vi.fn(), false],
}));

vi.mock("@/server/actions/pending.actions", () => ({
  createPendingAction: vi.fn(),
  updatePendingAction: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PendingEditForm, type PendingEditValues } from "./pending-edit-form";
import type { ProductOption } from "./pending-form";

// --------------------------------------------------------------------------
// La corrección de un pendiente ya cargado.
//
// Un pendiente viejo trae su producto con presentación guardada: esta pantalla
// la deja como está (no hay campo que la pise). El vendedor escrito a mano se
// corrige acá, llegando precargado para que guardar sin tocarlo lo conserve.
// --------------------------------------------------------------------------

const PRODUCTS: ProductOption[] = [
  { id: "p1", name: "Lantus Solostar", code: "LAN-1", orionCode: "7702001234567", unit: "Lapicera" },
];

function stored(overrides: Partial<PendingEditValues> = {}): PendingEditValues {
  return {
    id: "pend-1",
    productId: "p1",
    quantity: 2,
    promisedAt: new Date("2026-08-31T15:00:00.000Z"),
    customerName: "Ana Pérez",
    customerPhone: "3001234567",
    customerAddress: null,
    note: null,
    zone: null,
    totalAmount: null,
    paidAmount: 0,
    paymentMethod: null,
    manualSellerName: null,
    ...overrides,
  };
}

function renderEdit(pending: PendingEditValues): string {
  return renderToStaticMarkup(
    createElement(PendingEditForm, {
      pending,
      products: PRODUCTS,
      minQuantity: 0,
      isLastChance: false,
    }),
  );
}

function inputTag(html: string, id: string): string {
  const from = html.slice(html.indexOf(`id="${id}"`));
  return from.slice(0, from.indexOf(">"));
}

describe("PendingEditForm · pendiente con presentación guardada", () => {
  it("no ofrece ningún campo de presentación que pueda pisarla", () => {
    const html = renderEdit(stored());

    expect(html).not.toContain('name="manualUnit"');
    expect(html).not.toContain('name="unit"');
  });
});

describe("PendingEditForm · vendedor escrito a mano", () => {
  it("llega precargado con lo guardado, opcional y acotado", () => {
    const tag = inputTag(renderEdit(stored({ manualSellerName: "Carlos Gómez" })), "manualSellerName");

    expect(tag).toContain('name="manualSellerName"');
    expect(tag).toContain('value="Carlos Gómez"');
    expect(tag).toContain('maxLength="120"');
    expect(tag).not.toContain("required");
  });

  it("vacío cuando el pendiente no tiene vendedor escrito", () => {
    const tag = inputTag(renderEdit(stored()), "manualSellerName");

    expect(tag).toContain('value=""');
  });
});
