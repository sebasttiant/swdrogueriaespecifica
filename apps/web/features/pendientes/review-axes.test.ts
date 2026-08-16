import { describe, expect, it } from "vitest";

import {
  hasActiveAxis,
  parseReviewAxes,
  reviewHref,
  reviewPageHref,
  PURCHASE_AXIS_LABELS,
} from "./review-axes";

describe("parseReviewAxes", () => {
  it("acepta los tres ejes cuando los valores existen", () => {
    expect(
      parseReviewAxes({
        purchase: "SOLICITADO",
        availability: "LLEGO_BODEGA",
        customer: "CONTACTADO",
      }),
    ).toEqual({
      purchase: "SOLICITADO",
      availability: "LLEGO_BODEGA",
      customer: "CONTACTADO",
    });
  });

  // Estos valores terminan en un enum de PostgreSQL. Uno inventado reventaría
  // la consulta, así que se descarta y la vista queda sin filtrar.
  it("ignora un valor inventado en vez de propagarlo", () => {
    expect(parseReviewAxes({ purchase: "CUALQUIER-COSA" })).toEqual({});
  });

  it("ignora un eje que no vino", () => {
    expect(parseReviewAxes({})).toEqual({});
  });

  // Un eje inválido no puede tumbar a los que sí son válidos.
  it("conserva los ejes válidos aunque otro sea basura", () => {
    expect(
      parseReviewAxes({ purchase: "', DROP--", availability: "ESPERANDO" }),
    ).toEqual({ availability: "ESPERANDO" });
  });

  it("distingue mayúsculas: el enum es exacto", () => {
    expect(parseReviewAxes({ customer: "contactado" })).toEqual({});
  });
});

describe("hasActiveAxis", () => {
  it("es falso sin ningún eje", () => {
    expect(hasActiveAxis({})).toBe(false);
  });

  it("es verdadero con uno solo", () => {
    expect(hasActiveAxis({ customer: "FACTURADO" })).toBe(true);
  });
});

describe("reviewHref", () => {
  it("no ensucia la URL cuando no hay nada que decir", () => {
    expect(reviewHref({ scope: "active", view: "lista", axes: {} })).toBe("/pendientes");
  });

  it("mantiene scope y vista junto a los ejes", () => {
    expect(
      reviewHref({
        scope: "history",
        view: "detalle",
        axes: { purchase: "AGOTADO", customer: "CANCELADO" },
      }),
    ).toBe("/pendientes?scope=history&view=detalle&purchase=AGOTADO&customer=CANCELADO");
  });

  // Cambiar de filtro cambia el conjunto: el cursor viejo apunta a una fila que
  // el filtro nuevo puede no contener, y arrastrarlo mostraría una página del
  // medio como si fuera la primera.
  it("nunca arrastra el cursor", () => {
    const href = reviewHref({
      scope: "active",
      view: "lista",
      axes: { availability: "ESPERANDO" },
    });

    expect(href).not.toContain("cursor");
  });
});

describe("reviewPageHref", () => {
  // "Ver más" tiene que seguir mirando lo mismo. Si la página siguiente se
  // resolviera sin los filtros, cambiaría el conjunto a mitad del recorrido.
  it("conserva scope, vista y ejes junto al cursor", () => {
    expect(
      reviewPageHref({
        scope: "history",
        view: "detalle",
        axes: { availability: "LLEGO_BODEGA" },
        cursor: "cursor-2",
      }),
    ).toBe("/pendientes?cursor=cursor-2&scope=history&view=detalle&availability=LLEGO_BODEGA");
  });

  it("escapa el cursor en vez de pegarlo crudo", () => {
    const href = reviewPageHref({
      scope: "active",
      view: "lista",
      axes: {},
      cursor: "a b+c/d=",
    });

    expect(href).toBe("/pendientes?cursor=a+b%2Bc%2Fd%3D");
  });
});

describe("etiquetas", () => {
  // El filtro y la fila tienen que decir lo mismo, o parecen dos cosas
  // distintas. Por eso las de gestión se reusan en vez de reescribirse.
  it("reusa las etiquetas de gestión y agrega la que faltaba", () => {
    expect(PURCHASE_AXIS_LABELS.SOLICITADO).toBe("Solicitado");
    expect(PURCHASE_AXIS_LABELS.POR_PEDIR).toBe("Por pedir");
  });
});
