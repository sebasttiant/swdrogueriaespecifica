import { describe, expect, it } from "vitest";

import {
  REVIEW_TABS,
  REVIEW_TAB_LABELS,
  resolveReviewTab,
  reviewTabHref,
} from "./review-tab";

describe("resolveReviewTab", () => {
  // El default es seguimiento porque es lo que la pantalla hacía ANTES de que
  // existiera la pestaña. Un enlace viejo, un favorito o un WhatsApp con la URL
  // tienen que seguir llegando al mismo lugar.
  it("cae en 'seguimiento' sin parámetro", () => {
    expect(resolveReviewTab()).toBe("seguimiento");
    expect(resolveReviewTab(null)).toBe("seguimiento");
    expect(resolveReviewTab("")).toBe("seguimiento");
  });

  it("reconoce las dos mitades", () => {
    expect(resolveReviewTab("seguimiento")).toBe("seguimiento");
    expect(resolveReviewTab("abastecimiento")).toBe("abastecimiento");
  });

  // El parámetro viene de la URL: es input del usuario. Basura conocida cae en
  // la vista segura, nunca abre una mitad que no existe.
  it("cae en 'seguimiento' ante un valor desconocido", () => {
    expect(resolveReviewTab("compras")).toBe("seguimiento");
    expect(resolveReviewTab("ABASTECIMIENTO")).toBe("seguimiento");
    expect(resolveReviewTab("../../etc/passwd")).toBe("seguimiento");
  });
});

describe("reviewTabHref", () => {
  // Cambiar de mitad EMPIEZA LIMPIO. Los filtros de seguimiento (cliente,
  // disponibilidad) y los de abastecimiento (por pedir / ya pedidos) no se
  // entienden entre sí: arrastrarlos dejaría la otra pestaña filtrada por algo
  // que desde ahí no se ve, y el gerente vería una lista vacía sin saber por qué.
  it("vuelve a seguimiento sin arrastrar parámetros", () => {
    expect(reviewTabHref("seguimiento")).toBe("?");
  });

  it("nombra la mitad de abastecimiento", () => {
    expect(reviewTabHref("abastecimiento")).toBe("?tab=abastecimiento");
  });
});

describe("REVIEW_TAB_LABELS", () => {
  // Las palabras son las del gerente, no las del modelo. Y cada mitad tiene que
  // tener la suya: sin etiqueta, la pestaña se pinta vacía.
  it("le pone nombre a las dos mitades", () => {
    for (const tab of REVIEW_TABS) {
      expect(REVIEW_TAB_LABELS[tab]).toBeTruthy();
    }
    expect(REVIEW_TAB_LABELS.seguimiento).toBe("Seguimiento");
    expect(REVIEW_TAB_LABELS.abastecimiento).toBe("Abastecimiento");
  });
});
