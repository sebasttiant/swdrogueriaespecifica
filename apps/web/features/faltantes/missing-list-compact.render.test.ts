import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MissingItemListEntry } from "@/server/services/missing-item.service";

import { MissingListCompact } from "./missing-list-compact";

function item(overrides: Partial<MissingItemListEntry> = {}): MissingItemListEntry {
  return {
    id: "m-1",
    quantity: 4,
    orderedQuantity: null,
    receivedQuantity: 0,
    note: null,
    status: "FALTANTE",
    originId: null,
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    orderedAt: null,
    orderedById: null,
    orderedBy: null,
    discardedAt: null,
    discardedById: null,
    discardedBy: null,
    supplierId: null,
    sellerCode: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    product: {
      id: "p-1",
      name: "Acetaminofén 500mg",
      code: "ACE-500",
      unit: "unidad",
      laboratory: { id: "lab-1", name: "Genfar" },
    },
    origin: null,
    supplier: null,
    confirmedBy: null,
    createdBy: null,
    requestedByName: null,
    ...overrides,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function render(
  items: MissingItemListEntry[],
  nextCursor: string | null = null,
  canAct = false,
): string {
  return renderToStaticMarkup(
    createElement(MissingListCompact, {
      items,
      canAct,
      emptyTitle: "Nada por pedir",
      emptyDescription: "No queda ningún faltante esperando decisión.",
      nextCursor,
      pageHref: (cursor: string) => `/faltantes?view=compact&cursor=${cursor}`,
    }),
  );
}

describe("MissingListCompact", () => {
  it("shows the calculated deficit for an automatic missing item", () => {
    const out = render([item({ originId: "pending-1" })]);

    expect(out).toContain("Acetaminofén 500mg");
    expect(out).toContain("Genfar");
    expect(out).toContain("4");
  });

  it("shows seller code instead of the manual quantity sentinel", () => {
    const out = render([item({ quantity: 1, originId: null, sellerCode: "VEN-12" })]);

    expect(countOccurrences(out, "VEN-12")).toBe(2);
    expect(out).not.toContain("1 unidad");
    expect(out).toMatch(/<th[^>]*>Referencia<\/th>/);
  });

  // Lo compacto es justamente NO mostrar el seguimiento ni las acciones.
  it("omits code, status badges and order actions", () => {
    const out = render([item()]);

    expect(out).not.toContain("ACE-500"); // código de producto
    expect(out).not.toContain("Pedir"); // acción de pedido
    expect(out).not.toContain("Estado"); // encabezado de estado
  });

  it("falls back gracefully when the laboratory is missing", () => {
    const out = render([
      item({
        product: { id: "p-2", name: "Sin lab", code: "X-1", unit: "unidad", laboratory: null },
      }),
    ]);

    expect(out).toContain("Sin laboratorio");
  });

  // El vacío lo dicta la pestaña, no el componente: "no hay faltantes abiertos"
  // dentro de "Descartados" hacía dudar de si el descarte se había guardado.
  it("usa el vacío que le pasa la pestaña activa", () => {
    expect(render([])).toContain("Nada por pedir");
  });
});

describe("MissingListCompact · quién anotó (F1)", () => {
  // El pedido de gerencia: saber qué vendedor registró el faltante. La vista
  // compacta también lo necesita, no solo la completa.
  it("muestra el solicitante en la tarjeta mobile y en la tabla desktop", () => {
    const html = render([item({ requestedByName: "Juan Esteban" })]);

    // Una vez en la tarjeta mobile, otra en la fila desktop.
    expect(countOccurrences(html, "Juan Esteban")).toBe(2);
    expect(html).toMatch(/<th[^>]*>Solicitado por<\/th>/);
  });

  it("marca las filas sin solicitante sin romper la columna", () => {
    const html = render([item({ requestedByName: null })]);

    // La tabla desktop pone un guion; la tarjeta mobile simplemente lo omite.
    expect(html).toContain("—");
  });
});

// REGRESIÓN: la vista compacta es la del celular, y es donde el gerente escanea
// cientos de faltantes. Nació sin control de paginación: mostraba la primera
// página y las demás quedaban inalcanzables, dando a entender que no había más.
describe("MissingListCompact · paginación", () => {
  it("ofrece 'Ver más' cuando hay página siguiente", () => {
    const out = render([item({})], "cursor-2");

    expect(out).toContain("Ver más");
    expect(out).toContain("cursor=cursor-2");
  });

  it("no ofrece 'Ver más' en la última página", () => {
    const out = render([item({})], null);

    expect(out).not.toContain("Ver más");
  });

  // El destino lo decide la página (que sabe en qué vista está), no el
  // componente: así "Ver más" nunca devuelve a otra pestaña. El `&` viaja
  // escapado como `&amp;` porque es un atributo HTML, no una URL suelta.
  it("usa el destino que le pasa la página, sin construirlo por su cuenta", () => {
    const out = render([item({})], "cursor-9");

    expect(out).toContain("/faltantes?view=compact&amp;cursor=cursor-9");
  });
});

// Las dos salidas de un faltante, a un toque. Es lo que el gerente pidió con
// más urgencia: "yo marco los chulitos y ya... y que también haya forma de
// eliminarlos sin pedirlos".
describe("MissingListCompact · acciones de un toque", () => {
  it("ofrece pedir y descartar a la autoridad de compras", () => {
    const out = render([item({})], null, true);

    expect(out).toContain("Pedido");
    expect(out).toContain("Descartar");
  });

  // Esconder el botón no es seguridad —la Server Action rechaza igual— pero
  // ofrecerle a un vendedor un control que el servidor va a rechazar es mentirle.
  it("no ofrece acciones a quien no es autoridad de compras", () => {
    const out = render([item({})], null, false);

    expect(out).not.toContain("Descartar");
  });

  // ✓ y ✗ significan cosas OPUESTAS: si se parecieran, un toque equivocado
  // registraría una compra que nadie hizo. Deben distinguirse por texto —no
  // solo por color— y decir sobre QUÉ producto actúan, porque con decenas de
  // filas "Pedido" a secas no identifica cuál se está marcando.
  it("distingue las dos acciones por texto y nombra el producto", () => {
    const out = render([item({})], null, true);

    expect(out).toContain("Marcar Acetaminofén 500mg como pedido");
    expect(out).toContain("Descartar Acetaminofén 500mg");
  });

  // Una fila ya resuelta no tiene nada que marcar: ofrecer el botón invitaría a
  // un toque que el servidor va a saltear.
  it("no ofrece acciones sobre una fila ya pedida", () => {
    const out = render(
      [
        item({
          status: "PEDIDO",
          orderedAt: new Date("2026-07-30T14:00:00.000Z"),
          orderedBy: { id: "u-1", name: "Guillermo Bonilla" },
        }),
      ],
      null,
      true,
    );

    expect(out).not.toContain("Descartar");
  });
});

// Respaldo del gerente (min 2:52): "¿quién colocó esto? ... eso lo colocó Andrés".
describe("MissingListCompact · atribución", () => {
  it("muestra quién pidió el faltante", () => {
    const out = render([
      item({
        status: "PEDIDO",
        orderedAt: new Date("2026-07-30T14:00:00.000Z"),
        orderedBy: { id: "u-1", name: "Guillermo Bonilla" },
      }),
    ]);

    expect(out).toContain("Pedido por");
    expect(out).toContain("Guillermo Bonilla");
  });

  it("muestra quién lo descartó", () => {
    const out = render([
      item({
        status: "CANCELADO",
        discardedAt: new Date("2026-07-30T15:00:00.000Z"),
        discardedBy: { id: "u-2", name: "Andrés Bonilla" },
      }),
    ]);

    expect(out).toContain("Descartado por");
    expect(out).toContain("Andrés Bonilla");
  });

  // Nunca inventar un responsable ni caer al usuario que mira la pantalla.
  it("dice 'Sin registrar' en una fila heredada sin responsable", () => {
    const out = render([
      item({ status: "PEDIDO", orderedAt: new Date("2026-07-30T14:00:00.000Z") }),
    ]);

    expect(out).toContain("Sin registrar");
  });
});


// --------------------------------------------------------------------------
// Pedido de Andrés Bonilla (20/8/2026, vía Daniel): trabaja desde el celular y
// el nombre del producto le llegaba cortado, así que tenía que girar el
// teléfono para leerlo.
//
// El corte no molestaba por incompleto: se llevaba el FINAL, que en farmacia
// es donde vive lo que distingue un producto de otro —la presentación, la
// cantidad, la etapa, el laboratorio—. "PAÑITOS HUMEDOS HUGGI…" no dice cuál
// de todos los Huggies es.
//
// Se afirma sobre la clase porque acá la clase ES el comportamiento: el texto
// completo siempre estuvo en el DOM, lo que lo escondía era el CSS.
// --------------------------------------------------------------------------
describe("MissingListCompact · el nombre no se corta en el celular", () => {
  it("no aplica `truncate` a ningún dato de la tarjeta", () => {
    const html = render([item()]);

    expect(html).not.toContain("truncate");
  });
});

// --------------------------------------------------------------------------
// La columna "Acciones" prometía algo que no cumplía.
//
// El encabezado dependía SOLO de la capacidad; los botones dependen además de
// que la fila no esté ya atribuida. En "Ya pedidos" todas lo están, así que la
// tabla mostraba "ACCIONES" sobre una columna vacía y el operador se quedaba
// buscando el botón que dijera "ya llegó".
// --------------------------------------------------------------------------
describe("MissingListCompact · la columna Acciones no miente", () => {
  const yaPedido = item({
    orderedAt: new Date("2026-08-01T00:00:00.000Z"),
    orderedBy: { id: "u-1", name: "Super Admin" },
  });

  it("no dibuja el encabezado cuando ninguna fila ofrece acciones", () => {
    const out = render([yaPedido], null, true);

    expect(out).not.toContain("Acciones");
  });

  it("lo dibuja cuando al menos una fila sí las ofrece", () => {
    const out = render([item(), yaPedido], null, true);

    expect(out).toContain("Acciones");
  });

  it("sigue sin dibujarlo para quien no es autoridad de compras", () => {
    const out = render([item()], null, false);

    expect(out).not.toContain("Acciones");
  });
});

// --------------------------------------------------------------------------
// Cómo se cierra lo que ya se pidió.
//
// No hay —ni debe haber— un botón "ya llegó" acá: un faltante se salda cuando
// bodega registra la entrada con su lote y su vencimiento. Un botón que no
// registre el lote inventaría stock y rompería el FEFO. Pero si la pantalla no
// lo dice, la cola parece un pozo donde las cosas entran y no salen.
// --------------------------------------------------------------------------
describe("MissingListCompact · dice cómo se cierra lo ya pedido", () => {
  const yaPedido = item({
    orderedAt: new Date("2026-08-01T00:00:00.000Z"),
    orderedBy: { id: "u-1", name: "Super Admin" },
  });

  it("explica que se cierra al registrar la entrada, y enlaza ahí", () => {
    const out = render([yaPedido], null, true);

    expect(out).toContain("bodega registra la entrada");
    expect(out).toContain('href="/entradas"');
  });

  it("no lo dice en la cola de lo que todavía hay que pedir", () => {
    const out = render([item()], null, true);

    expect(out).not.toContain("bodega registra la entrada");
  });

  it("tampoco cuando la página mezcla pedidos con pendientes de decisión", () => {
    const out = render([item(), yaPedido], null, true);

    expect(out).not.toContain("bodega registra la entrada");
  });
});
