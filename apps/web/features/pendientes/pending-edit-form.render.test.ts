import { describe, expect, it, vi } from "vitest";

const { actionState } = vi.hoisted(() => ({
  actionState: { current: { error: null, ok: false } as Record<string, unknown> },
}));

vi.mock("@/lib/hooks/use-action-state", () => ({
  useActionState: () => [actionState.current, vi.fn(), false],
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
    updatedAt: new Date("2026-08-30T12:00:00.123Z"),
    ...overrides,
  };
}

function renderEdit(
  pending: PendingEditValues,
  options: { restricted?: boolean; productLocked?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(PendingEditForm, {
      pending,
      products: PRODUCTS,
      minQuantity: 0,
      isLastChance: false,
      ...options,
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

// --------------------------------------------------------------------------
// Corrección compartida (gerencia, 2026-09-30).
// --------------------------------------------------------------------------
const PROTECTED_INPUTS = [
  "customerName",
  "customerPhone",
  "customerAddress",
  "totalAmount",
  "paidAmount",
  "paymentMethod",
];

describe("PendingEditForm · testigo de concurrencia", () => {
  it.each([false, true])("viaja oculto con el updatedAt de la carga (restringida=%s)", (restricted) => {
    const html = renderEdit(stored(), { restricted });
    const tag = html.match(/<input[^>]*name="expectedUpdatedAt"[^>]*>/)?.[0] ?? "";

    expect(tag).toContain('type="hidden"');
    expect(tag).toContain('value="2026-08-30T12:00:00.123Z"');
  });
});

describe("PendingEditForm · corrección restringida (fila ajena)", () => {
  it("no renderiza identidad, montos ni vendedor escrito: no se envían", () => {
    const html = renderEdit(
      stored({ customerName: null, customerPhone: null, paidAmount: 5000 }),
      { restricted: true },
    );

    for (const field of [...PROTECTED_INPUTS, "manualSellerName"]) {
      expect(html).not.toContain(`name="${field}"`);
    }
    // Lo editable sigue ahí.
    for (const field of ["productId", "quantity", "promisedAt", "zone", "note"]) {
      expect(html).toContain(`name="${field}"`);
    }
  });

  it("con el producto bloqueado, lo muestra deshabilitado, lo conserva y explica por qué", () => {
    const html = renderEdit(stored(), { restricted: true, productLocked: true });

    const select = inputTag(html, "productId");
    expect(select).toContain("disabled");
    expect(select).not.toContain('name="productId"');
    expect(html).toContain('type="hidden" name="productId" value="p1"');
    expect(html).toContain("ya tiene unidades facturadas o entregadas");
  });

  it("la corrección completa conserva todos sus campos", () => {
    const html = renderEdit(stored());

    for (const field of PROTECTED_INPUTS.filter((f) => f !== "paymentMethod")) {
      expect(html).toContain(`name="${field}"`);
    }
  });
});

describe("PendingEditForm · guardar sin cambios", () => {
  it("dice que no había cambios, no que se corrigió", () => {
    actionState.current = { error: null, ok: true, unchanged: true };
    try {
      const html = renderEdit(stored());

      expect(html).toContain("No había cambios para guardar.");
      expect(html).not.toContain("Pendiente corregido.");
    } finally {
      actionState.current = { error: null, ok: false };
    }
  });
});
