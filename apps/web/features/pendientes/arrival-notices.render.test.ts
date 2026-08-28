import { describe, expect, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ArrivalNotice } from "@/server/services/arrival-notice.service";

import { ArrivalNotices } from "./arrival-notices";

function notice(overrides: Partial<ArrivalNotice> = {}): ArrivalNotice {
  return {
    pendingId: "pend-1",
    productName: "Amoxicilina 500mg",
    quantity: 3,
    readyQuantity: 3,
    availabilityStatus: "DISPONIBLE_COMPLETO",
    customerName: "Doña Marta",
    noticedAt: new Date("2026-08-28T14:30:00Z"),
    ...overrides,
  };
}

function render(props: Parameters<typeof ArrivalNotices>[0]): string {
  return renderToStaticMarkup(createElement(ArrivalNotices, props));
}

describe("ArrivalNotices", () => {
  it("no ocupa lugar cuando no hay avisos", () => {
    const html = render({ notices: [], canViewCustomerIdentity: true });

    expect(html).toBe("");
  });

  it("nombra el producto y cuánto hay disponible", () => {
    const html = render({
      notices: [notice({ readyQuantity: 3, quantity: 3 })],
      canViewCustomerIdentity: true,
    });

    expect(html).toContain("Llegó completo");
    expect(html).toContain("Amoxicilina 500mg");
    expect(html).toContain("3 de 3 disponibles");
  });

  it("distingue el parcial, que es la decisión difícil del vendedor", () => {
    const html = render({
      notices: [
        notice({ availabilityStatus: "DISPONIBLE_PARCIAL", readyQuantity: 1, quantity: 3 }),
      ],
      canViewCustomerIdentity: true,
    });

    expect(html).toContain("Llegó una parte");
    expect(html).toContain("1 de 3 disponibles");
    expect(html).not.toContain("Llegó completo");
  });

  it("enlaza al pendiente concreto", () => {
    const html = render({
      notices: [notice({ pendingId: "pend-42" })],
      canViewCustomerIdentity: true,
    });

    expect(html).toContain("#pendiente-pend-42");
  });

  // El nombre del cliente es PII y se minimiza server-side igual que en el
  // resto de la pantalla: quien no puede verlo, tampoco acá.
  it("oculta el nombre del cliente a quien no puede verlo", () => {
    const html = render({
      notices: [notice({ customerName: "Doña Marta" })],
      canViewCustomerIdentity: false,
    });

    expect(html).not.toContain("Doña Marta");
    expect(html).toContain("Amoxicilina 500mg");
  });

  it("no rompe cuando el pendiente no tiene cliente cargado", () => {
    const html = render({
      notices: [notice({ customerName: null })],
      canViewCustomerIdentity: true,
    });

    expect(html).toContain("Amoxicilina 500mg");
  });

  it("cuenta los avisos en el encabezado", () => {
    const html = render({
      notices: [
        notice({ pendingId: "a" }),
        notice({ pendingId: "b" }),
        notice({ pendingId: "c" }),
      ],
      canViewCustomerIdentity: true,
    });

    expect(html).toContain("Ya llegó (3)");
  });

  it("singulariza la unidad", () => {
    const html = render({
      notices: [notice({ quantity: 1, readyQuantity: 1 })],
      canViewCustomerIdentity: true,
    });

    expect(html).toContain("1 de 1 disponible");
    expect(html).not.toContain("1 de 1 disponibles");
  });
});
