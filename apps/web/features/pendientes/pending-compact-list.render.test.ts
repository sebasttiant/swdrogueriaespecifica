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
import { IDENTITY_WARNING_LABEL } from "./identity-warning";

import { PendingCompactList } from "./pending-compact-list";
import { globalViewer, noAuthorityViewer } from "./pending-viewer.fixture";

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
    cancelledQuantity: 0,
    // Ver la nota del mismo fixture en `pending-list.render.test.ts`: sin
    // motivo de aplazamiento no hay aviso, tenga o no código el producto.
    identitySkippedReason: null,
    requestedLaboratory: null,
    product: {
      id: "prod-1",
      name: "Paracetamol",
      code: "P-001",
      unit: "unidad",
      orionCode: null,
    },
    ...overrides,
  };
}

function render(
  items: PendingListItem[],
  canOrder = true,
  nextCursor: string | null = null,
  capabilities: {
    canDeliver?: boolean;
    // Antes era `canContactOrInvoice`. Ahora la autoridad viaja con su ALCANCE,
    // porque ofrecer facturar depende también de de quién es la fila.
    canInvoice?: boolean;
    canFollowUp?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(PendingCompactList, {
      items,
      canOrder,
      canDeliver: capabilities.canDeliver,
      viewer: capabilities.canInvoice ? globalViewer() : noAuthorityViewer,
      canFollowUp: capabilities.canFollowUp,
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
    // T2.2b: el cierre parcial tiene label propio, no "Entregado".
    ["CLOSED_PARTIAL", "Cerrado parcial"],
  ] as const)("no rotula %s como 'Pendiente'", (status, label) => {
    const html = render([pending({ status })], true);

    expect(html).toContain(label);
    expect(html).not.toContain(">Pendiente<");
  });

  // El estado del pedido arranca en "Pendiente" y avanza a Facturado, Entregado
  // o Cancelado. Lo que gerencia anota sobre la compra es otro eje y va aparte.
  it("dice 'Pendiente' en lo que todavía no se facturó", () => {
    const html = render([pending()]);

    expect(html).toContain("Pendiente");
  });

  it("pasa a 'Facturado' cuando el vendedor ya facturó", () => {
    const html = render([pending({ customerStatus: "FACTURADO", invoicedQuantity: 10 })]);

    expect(html).toContain("Facturado");
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

  it("usa purchaseStatus, no el status histórico, para la acción de compras", () => {
    const html = render([pending({ status: "SOLICITADO", purchaseStatus: "POR_PEDIR" })]);

    expect(html).toContain("Pendiente");
    expect(html).toContain("Ya lo pedí");
  });

  // El vendedor factura SU pendiente en las dos vistas —tarjeta y tabla— sin
  // necesitar autoridad de compras. Lo que sí necesita es que la mercadería
  // haya llegado: ver el caso de abajo.
  it("le da al vendedor la acción de facturar en las dos vistas", () => {
    const html = render(
      [pending({ customerStatus: "POR_CONTACTAR", inventoryReadyQuantity: 10, purchaseStatus: "SOLICITADO" })],
      false,
      null,
      { canInvoice: true },
    );

    // "Facturar" a secas es subcadena de "Facturar el resto", así que contarla
    // sola no distingue el caso completo del parcial. Se fijan las dos.
    expect(countOccurrences(html, "Facturar")).toBe(2);
    expect(html).not.toContain("Facturar el resto");
    expect(html).not.toContain("Ya le facturé");
    expect(html).not.toContain("Ya lo pedí");
  });

  // El defecto que reportó gerencia el 2026-10-04: se ofrecía "Facturar" sobre
  // pendientes sin una sola unidad en bodega. La autoridad no alcanza; hace
  // falta mercadería. Antes este caso mostraba el botón igual.
  it("no ofrece facturar cuando no llegó mercadería, aunque tenga la autoridad", () => {
    const html = render(
      [pending({ customerStatus: "POR_CONTACTAR", inventoryReadyQuantity: 0, purchaseStatus: "SOLICITADO" })],
      false,
      null,
      { canInvoice: true },
    );

    expect(html).not.toContain("Facturar");
    expect(html).not.toContain("podés facturar");
  });

  it("shows seller invoice actions in the desktop table", () => {
    const html = render(
      [pending({ customerStatus: "CONTACTADO", inventoryReadyQuantity: 10, invoicedQuantity: 0, purchaseStatus: "SOLICITADO" })],
      false,
      null,
      { canInvoice: true, canDeliver: true },
    );

    expect(countOccurrences(html, "Facturar")).toBe(2);
    expect(html).not.toContain("Facturar el resto");
    expect(html).not.toContain("Ya le facturé");
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
      { canInvoice: true },
    );

    expect(countOccurrences(html, "Cargado · podés facturar")).toBe(2);
  });

  it("distingue la cobertura parcial de la completa", () => {
    const html = render(
      [pending({ quantity: 10, customerStatus: "CONTACTADO", inventoryReadyQuantity: 6, invoicedQuantity: 0 })],
      false,
      null,
      { canInvoice: true },
    );

    expect(
      countOccurrences(html, "Sin stock suficiente · 6 de 10 restantes disponibles"),
    ).toBe(2);
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

    expect(html).not.toContain("podés facturar");
    expect(html).not.toContain("Listo para entregar");
  });
});

// Regresión de producción (2026-07-30): la tabla de escritorio no chequeaba la
// autoridad de compras, así que el vendedor veía "Ya lo pedí" y "Agotado" —
// decisiones de gerencia— en la vista que usa desde el computador.
describe("PendingCompactList · autoridad de compras", () => {
  it("no ofrece acciones de compras a quien no las tiene, en ninguna vista", () => {
    const html = render([pending()], false);

    expect(html).not.toContain("Ya lo pedí");
    expect(html).not.toContain("Agotado");
    expect(html).not.toContain("En búsqueda");
    expect(html).not.toContain("Cotizando");
  });

  it("las ofrece a gerencia en móvil y escritorio", () => {
    const html = render([pending()], true);

    expect(countOccurrences(html, "Ya lo pedí")).toBe(2);
  });
});

// --------------------------------------------------------------------------
// Los colores que gerencia ya tiene aprendidos de su tabla de siempre
// (reunión, minuto 5:19 y 7:13). Cada uno lleva TEXTO además de color: estas
// filas se leen en un celular al sol, y el color solo no alcanza.
//
//   verde    → llegó a la droguería, todavía sin cargar al sistema
//   amarillo → bodega ya lo cargó; el vendedor puede llamar y facturar
//   morado   → no es una unidad, son varias
// --------------------------------------------------------------------------
describe("PendingCompactList · señales de la reunión", () => {
  it("prioriza la falta de stock cuando llegó pero todavía no está cargado", () => {
    const html = render([
      pending({ availabilityStatus: "LLEGO_BODEGA", inventoryReadyQuantity: 0 }),
    ]);

    expect(countOccurrences(html, "Sin stock")).toBe(2);
    expect(html).not.toContain("Llegó a la droguería");
    expect(html).not.toContain("podés facturar");
  });

  it("cambia el aviso cuando bodega ya lo cargó", () => {
    const html = render(
      [pending({ availabilityStatus: "DISPONIBLE_COMPLETO", inventoryReadyQuantity: 10 })],
      true,
      null,
      { canInvoice: true },
    );

    expect(countOccurrences(html, "Cargado · podés facturar")).toBe(2);
    expect(html).not.toContain("Llegó a la droguería");
  });

  // El aviso NO promete lo que el lector no puede hacer. Con la mercadería
  // cargada pero sin autoridad, el hecho se enuncia y ahí termina. Era la
  // contradicción exacta de la pantalla de Garzón: la fila decía "podés
  // facturar" y abajo no había ningún botón.
  it("dice Cargado sin prometer facturar a quien no puede", () => {
    const html = render([
      pending({ availabilityStatus: "DISPONIBLE_COMPLETO", inventoryReadyQuantity: 10 }),
    ]);

    expect(countOccurrences(html, "Cargado")).toBe(2);
    expect(html).not.toContain("podés facturar");
  });

  it("distingue la cobertura parcial de lo cargado", () => {
    const html = render([
      pending({ quantity: 10, availabilityStatus: "DISPONIBLE_PARCIAL", inventoryReadyQuantity: 6 }),
    ]);

    expect(
      countOccurrences(html, "Sin stock suficiente · 6 de 10 restantes disponibles"),
    ).toBe(2);
  });

  it("marca cuando se piden varias unidades, no una sola", () => {
    expect(countOccurrences(render([pending({ quantity: 25 })]), "Varias")).toBe(2);
  });

  it("no marca 'Varias' cuando es una sola unidad", () => {
    expect(render([pending({ quantity: 1 })])).not.toContain("Varias");
  });

  it("deja de avisar disponibilidad cuando el pendiente ya se facturó", () => {
    const html = render([
      pending({
        customerStatus: "FACTURADO",
        invoicedQuantity: 10,
        availabilityStatus: "DISPONIBLE_COMPLETO",
        inventoryReadyQuantity: 10,
      }),
    ]);

    expect(html).not.toContain("podés facturar");
    expect(countOccurrences(html, "Listo para entregar")).toBe(2);
    expect(html).not.toMatch(/Facturado · listo para entregar/i);
  });
});

// --------------------------------------------------------------------------
// Seguimiento y trazabilidad: VER la jornada completa. Quien gestiona TODOS los
// pendientes supervisa, y para eso tiene que leer cliente, zona, saldo y la
// nota del vendedor sobre la MISMA fila. Abrir el detalle de cada uno, con 36
// en la cola a las 9:30 de la mañana, no es supervisar.
//
// El vendedor no lo lleva: sus filas son suyas y ya sabe a quién le vende.
// --------------------------------------------------------------------------
describe("PendingCompactList · seguimiento", () => {
  const conCliente = () =>
    pending({
      customerName: "María Gómez",
      customerPhone: "3001234567",
      zone: "Norte",
      totalAmount: 50_000,
      paidAmount: 20_000,
      note: "Cliente espera los 2 restantes",
    });

  it("pone cliente, teléfono, zona, saldo y nota sobre la fila", () => {
    const html = render([conCliente()], true, null, { canFollowUp: true });

    expect(html).toContain("María Gómez");
    expect(html).toContain("3001234567");
    expect(html).toContain("Norte");
    expect(html).toContain("Cliente espera los 2 restantes");
    // Lo que importa al entregar es lo que falta cobrar, no lo ya abonado.
    expect(html).toContain("Debe");
  });

  it("muestra la HORA comprometida, no solo el día", () => {
    const html = render([conCliente()], true, null, { canFollowUp: true });
    const sinSeguimiento = render([conCliente()]);

    expect(html).toContain(":");
    expect(sinSeguimiento).not.toContain("María Gómez");
  });

  it("no le muestra datos de cliente a quien no hace seguimiento", () => {
    const html = render([conCliente()], true, null, { canInvoice: true });

    expect(html).not.toContain("María Gómez");
    expect(html).not.toContain("3001234567");
    expect(html).not.toContain("Cliente espera los 2 restantes");
  });

  it("no inventa saldo cuando no se acordó un total", () => {
    const html = render(
      [pending({ customerName: "Ana", totalAmount: null, paidAmount: 0 })],
      true,
      null,
      { canFollowUp: true },
    );

    expect(html).toContain("Ana");
    expect(html).not.toContain("Debe");
    expect(html).not.toContain("Pagado");
  });

  it("marca como pagado lo que ya cubrió el total", () => {
    const html = render(
      [pending({ customerName: "Ana", totalAmount: 50_000, paidAmount: 50_000 })],
      true,
      null,
      { canFollowUp: true },
    );

    expect(html).toContain("Pagado");
    expect(html).not.toContain("Debe");
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
describe("PendingCompactList · el nombre no se corta en el celular", () => {
  it("no aplica `truncate` a ningún dato de la tarjeta", () => {
    const html = render([pending()]);

    expect(html).not.toContain("truncate");
  });
});

// --------------------------------------------------------------------------
// S2b · 1e-E — el aviso de identidad pendiente en la vista compacta.
//
// Esta vista pinta la MISMA fila dos veces: tarjeta en el celular y renglón en
// la tabla del escritorio. El aviso tiene que estar en las dos, o gerencia lo
// ve en el escritorio y el vendedor no lo ve en el mostrador —que es
// exactamente donde se puede hacer algo al respecto.
// --------------------------------------------------------------------------
describe("PendingCompactList · identidad pendiente", () => {
  it("avisa en la tarjeta Y en la tabla cuando el producto sigue sin código", () => {
    const html = render([pending({ identitySkippedReason: "ORION_UNAVAILABLE" })]);

    // Dos veces: móvil + tabla. Una sola aparición significaría que una de las
    // dos vistas se quedó sin el aviso.
    expect(countOccurrences(html, IDENTITY_WARNING_LABEL)).toBe(2);
  });

  it("no avisa en ninguna de las dos vistas si el producto ya tiene código", () => {
    const html = render([
      pending({
        identitySkippedReason: "ORION_UNAVAILABLE",
        product: {
          id: "prod-1",
          name: "Paracetamol",
          code: "P-001",
          unit: "unidad",
          orionCode: "ORN-500",
        },
      }),
    ]);

    expect(html).not.toContain(IDENTITY_WARNING_LABEL);
  });

  it("no avisa por un producto sin código que nadie aplazó", () => {
    const html = render([pending()]);

    expect(html).not.toContain(IDENTITY_WARNING_LABEL);
  });

  it("dice el aviso con texto, no solo con un color", () => {
    const html = render([pending({ identitySkippedReason: "CODE_NOT_FOUND" })]);

    expect(html).toContain(`>${IDENTITY_WARNING_LABEL}<`);
  });
});
