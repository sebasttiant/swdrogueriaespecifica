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
  resolveWaitlistDecisionAction: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PendingListItem } from "@/server/repositories/pending.repository";
import { IDENTITY_WARNING_LABEL } from "./identity-warning";

import { PendingCompactList } from "./pending-compact-list";
import { fulfillmentNotice, type PendingViewer } from "./fulfillment-notice";
import { globalViewer, noAuthorityViewer, ownerViewer } from "./pending-viewer.fixture";

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
    paymentMethod: null,
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
    // Para probar el alcance propio; si viene, gana sobre `canInvoice`.
    viewer?: PendingViewer;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(PendingCompactList, {
      items,
      canOrder,
      canDeliver: capabilities.canDeliver,
      viewer:
        capabilities.viewer ?? (capabilities.canInvoice ? globalViewer() : noAuthorityViewer),
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
describe("PendingCompactList · Orion SKU", () => {
  it.each([false, true])("shows Orion in both representations with management=%s", (canOrder) => {
    const item = pending({ product: { ...pending().product, code: "MAN-123", orionCode: "001234" } });
    const html = render([item], canOrder, null, { canFollowUp: canOrder });
    const representations = html.split("<table");
    expect(representations).toHaveLength(2);

    for (const representation of representations) {
      expect(countOccurrences(representation, "SKU / Código Orion: 001234")).toBe(1);
      expect(representation).not.toContain("MAN-123");
    }
    expect(html.match(/<th /g)).toHaveLength(canOrder ? 6 : 5);
  });

  it("shows legacy missing codes in both views without an invented identifier or warning", () => {
    const html = render([pending({ product: { ...pending().product, code: "MAN-123" } })]);
    expect(countOccurrences(html, "SKU / Código Orion: Sin código")).toBe(2);
    expect(html).not.toContain("MAN-123");
    expect(html).not.toContain(IDENTITY_WARNING_LABEL);
  });

  it("allows long unbroken codes to wrap in both views", () => {
    const code = "001234".repeat(40);
    const html = render([pending({ product: { ...pending().product, orionCode: code } })]);
    expect(countOccurrences(html, `SKU / Código Orion: ${code}</p>`)).toBe(2);
    expect(html.match(/<p class="[^"]*\[overflow-wrap:anywhere\][^"]*text-xs[^"]*">SKU \/ Código Orion:/g)).toHaveLength(2);
    expect(html).toContain('min-w-[48rem]');
    expect(html.match(/<th /g)).toHaveLength(6);
  });
});

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

  // La cuenta del mostrador es compartida: el nombre ESCRITO dice quién atendió,
  // junto a la cuenta que lo registró, en las dos representaciones.
  it("muestra el vendedor escrito a mano junto a la cuenta que lo registró", () => {
    const html = render([
      pending({ createdBy: { id: "u-m", name: "Mostrador" }, manualSellerName: "Carlos Gómez" }),
    ]);

    expect(countOccurrences(html, "Mostrador")).toBe(2);
    expect(countOccurrences(html, "Vendedor: Carlos Gómez")).toBe(2);
    // Solo lectura: no se ofrece ningún campo para cambiarlo desde el listado.
    expect(html).not.toContain('name="manualSellerName"');
  });

  it.each([null, undefined])("sin vendedor escrito (%s) no pinta nada extra", (manualSellerName) => {
    const html = render([pending({ manualSellerName })]);

    expect(html).not.toContain("Vendedor:");
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

  // U5: sin mercadería cargada el formulario SÍ se ofrece, porque la
  // facturación excepcional sin stock existe (con su segunda confirmación en el
  // cliente y su rastro en la auditoría). Lo que no cambia es el aviso: la fila
  // sigue diciendo "Sin stock" y no se pinta de amarillo.
  it("sin mercadería cargada ofrece el formulario, pero la fila sigue sin stock", () => {
    const html = render(
      [pending({ customerStatus: "POR_CONTACTAR", inventoryReadyQuantity: 0, purchaseStatus: "SOLICITADO" })],
      false,
      null,
      { canInvoice: true },
    );

    expect(countOccurrences(html, 'name="expectedInvoicedQuantity" value="0"')).toBe(2);
    expect(countOccurrences(html, "Sin stock")).toBe(2);
    expect(html).not.toContain("Listo para facturar");
    expect(html).not.toContain("border-l-warning");
    expect(html).not.toContain("podés facturar");
  });

  it("sin mercadería cargada no ofrece el formulario fuera del alcance", () => {
    const fila = pending({ customerStatus: "POR_CONTACTAR", inventoryReadyQuantity: 0 });

    expect(render([fila], false, null, { viewer: ownerViewer("otro-vendedor") })).not.toContain(
      "expectedInvoicedQuantity",
    );
    expect(render([fila], false, null, {})).not.toContain("expectedInvoicedQuantity");
    // La fila es de "u-1": su dueño con alcance propio sí la factura.
    expect(
      countOccurrences(
        render([fila], false, null, { viewer: ownerViewer("u-1") }),
        'name="expectedInvoicedQuantity"',
      ),
    ).toBe(2);
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

  // --------------------------------------------------------------------------
  // Lista de espera: registrar que el cliente acepta esperar.
  //
  // El gesto ya existía, pero atado a la entrega parcial. Ahora aplica a casi
  // toda la cola abierta, y eso obliga a cuidar la DENSIDAD: lo que antes salía
  // en filas raras ahora saldría en todas.
  // --------------------------------------------------------------------------
  it("ofrece registrar la espera en un pendiente del que no llegó nada", () => {
    const html = render([pending()], false, null, { canDeliver: true });

    expect(countOccurrences(html, "Lo espera")).toBe(2); // móvil + tabla
    expect(countOccurrences(html, "Va con otro pedido")).toBe(2);
  });

  // La forma compacta es el punto: un panel con pregunta en cada fila inflaría
  // la tarjeta del celular y ensancharía la columna "Acción" en TODAS las filas.
  it("no mete la pregunta ni el panel cuando no hubo entrega", () => {
    const html = render([pending()], false, null, { canDeliver: true });

    expect(html).not.toContain("¿Qué hace el cliente?");
    expect(html).not.toContain("bg-muted/30");
    // Tampoco ofrece cerrar: un pendiente del que no salió nada se cancela.
    expect(html).not.toContain("No los espera");
  });

  // No regresión: la entrega parcial es un EVENTO y conserva su panel completo,
  // exactamente como estaba en producción.
  it("conserva el panel completo tras una entrega parcial", () => {
    const html = render(
      [pending({ status: "PARCIAL", quantity: 5, deliveredQuantity: 3 })],
      false,
      null,
      { canDeliver: true },
    );

    expect(countOccurrences(html, "Faltan 2. ¿Qué hace el cliente?")).toBe(2);
    expect(countOccurrences(html, "Espera el resto")).toBe(2);
    expect(countOccurrences(html, "No los espera")).toBe(2);
  });

  it("no ofrece el gesto sobre un pendiente AGOTADO", () => {
    const html = render([pending({ status: "AGOTADO" })], false, null, { canDeliver: true });

    expect(html).not.toContain("Lo espera");
  });

  // Respondida la pregunta, el gesto desaparece y la fila muestra la respuesta:
  // volver a preguntar hacía ver la acción como si no hubiera funcionado.
  it("cambia el gesto por la respuesta, con las palabras del caso", () => {
    const sinEntrega = render([pending({ waitlistDecision: "ESPERA" })], false, null, {
      canDeliver: true,
    });
    expect(countOccurrences(sinEntrega, "El cliente lo espera")).toBe(2);
    expect(sinEntrega).not.toContain("Lo espera</button>");

    const conEntrega = render(
      [pending({ status: "PARCIAL", deliveredQuantity: 3, waitlistDecision: "ESPERA" })],
      false,
      null,
      { canDeliver: true },
    );
    expect(countOccurrences(conEntrega, "El cliente espera el resto")).toBe(2);
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

    expect(countOccurrences(html, "Listo para facturar")).toBe(2);
  });

  // Regla única (U4): la parcial cargada se puede facturar, así que es amarilla
  // con "X de Y". Antes salía en rojo "Sin stock suficiente" con el botón de
  // facturar debajo.
  it("distingue la cobertura parcial de la completa", () => {
    const html = render(
      [pending({ quantity: 10, customerStatus: "CONTACTADO", inventoryReadyQuantity: 6, invoicedQuantity: 0 })],
      false,
      null,
      { canInvoice: true },
    );

    expect(countOccurrences(html, "Listo para facturar: 6 de 10")).toBe(2);
    expect(html).not.toContain("Sin stock");
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

    expect(countOccurrences(html, "Listo para facturar")).toBe(2);
    expect(html).not.toContain("Llegó a la droguería");
  });

  // El aviso describe el PENDIENTE, no a quien lo lee: dice lo mismo tenga o no
  // autoridad el lector, y por eso no puede contradecir a los controles de
  // abajo. Era la contradicción exacta de la pantalla de Garzón, donde la fila
  // decía "podés facturar" y no había ningún botón.
  //
  // Se compara CON y SIN autoridad en el mismo test a propósito: el día que
  // alguien vuelva a meterle el lector al texto, esto falla.
  it("da el mismo aviso tenga o no autoridad quien mira", () => {
    const fila = pending({
      availabilityStatus: "DISPONIBLE_COMPLETO",
      inventoryReadyQuantity: 10,
    });

    const sinAutoridad = render([fila]);
    const conAutoridad = render([fila], true, null, { canInvoice: true });

    expect(countOccurrences(sinAutoridad, "Listo para facturar")).toBe(2);
    expect(countOccurrences(conAutoridad, "Listo para facturar")).toBe(2);
    // Segunda persona nunca más en este aviso.
    expect(sinAutoridad).not.toContain("podés");
    expect(conAutoridad).not.toContain("podés");
  });

  // Misma regla única que arriba, sin autoridad: el aviso describe el pendiente.
  it("distingue la cobertura parcial de lo cargado", () => {
    const html = render([
      pending({ quantity: 10, availabilityStatus: "DISPONIBLE_PARCIAL", inventoryReadyQuantity: 6 }),
    ]);

    expect(countOccurrences(html, "Listo para facturar: 6 de 10")).toBe(2);
  });

  // U4 — color de estado local: tarjeta del celular Y primera celda de la tabla.
  it("pinta el borde amarillo en las dos vistas cuando está listo, aunque esté agotado", () => {
    const html = render([
      pending({ purchaseStatus: "AGOTADO", inventoryReadyQuantity: 6, invoicedQuantity: 0 }),
    ]);

    expect(countOccurrences(html, "border-l-warning")).toBe(2);
    expect(html).not.toContain("border-l-danger");
  });

  it("pinta el borde rojo en las dos vistas cuando está agotado sin nada que facturar", () => {
    const html = render([pending({ purchaseStatus: "AGOTADO", inventoryReadyQuantity: 0 })]);

    expect(countOccurrences(html, "border-l-danger")).toBe(2);
    expect(html).not.toContain("border-l-warning");
  });

  it("no pinta borde de estado en un pendiente sin acción ni agotado", () => {
    const html = render([pending({ purchaseStatus: "SOLICITADO" })]);

    expect(html).not.toContain("border-l-warning");
    expect(html).not.toContain("border-l-danger");
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
      paymentMethod: null,
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

// --------------------------------------------------------------------------
// Cada pendiente DICE lo que pasó, no solo lo pinta, en la tarjeta del celular
// Y en el renglón de la tabla. La llegada a bodega va en su propia línea verde;
// el borde rojo va siempre acompañado de la palabra "Agotado".
// --------------------------------------------------------------------------
describe("PendingCompactList · qué pasó con el pendiente", () => {
  const arrivalLine = (label: string) =>
    `<p class="min-w-0 max-w-full whitespace-normal break-words text-sm font-medium text-success">${label}</p>`;
  const SOLD_OUT_BADGE = 'text-danger">Agotado</span>';
  const PURCHASE_TEXT = 'text-xs text-muted-foreground">Agotado</span>';

  it("dice que ya llegó a bodega en las dos vistas, y el rojo sigue igual", () => {
    const html = render([
      pending({ availabilityStatus: "LLEGO_BODEGA", inventoryReadyQuantity: 0 }),
    ]);

    expect(countOccurrences(html, arrivalLine("Ya llegó a bodega"))).toBe(2);
    expect(countOccurrences(html, "Sin stock")).toBe(2);
  });

  it("dice que llegó una parte en las dos vistas, junto al amarillo", () => {
    const html = render([
      pending({ quantity: 10, availabilityStatus: "DISPONIBLE_PARCIAL", inventoryReadyQuantity: 6 }),
    ]);

    expect(countOccurrences(html, arrivalLine("Ya llegó parte a bodega"))).toBe(2);
    expect(countOccurrences(html, "Listo para facturar: 6 de 10")).toBe(2);
  });

  it("no dice nada de llegada mientras sigue esperando", () => {
    expect(render([pending({ availabilityStatus: "ESPERANDO" })])).not.toContain("Ya llegó");
  });

  it("la línea de llegada reemplaza al viejo aviso verde en las dos vistas", () => {
    const fila = pending({
      status: "PARCIAL",
      availabilityStatus: "LLEGO_BODEGA",
      deliveredQuantity: 6,
      cancelledQuantity: 4,
    });
    // La fila produce de verdad el aviso verde legado: sin esto el test no
    // discriminaría.
    expect(fulfillmentNotice(fila)?.tone).toBe("success");

    const html = render([fila]);

    expect(countOccurrences(html, arrivalLine("Ya llegó a bodega"))).toBe(2);
    expect(html).not.toContain("Llegó a la droguería");
  });

  it("el azul de listo para entregar sigue al lado de la llegada", () => {
    const html = render([
      pending({
        availabilityStatus: "DISPONIBLE_COMPLETO",
        customerStatus: "FACTURADO",
        inventoryReadyQuantity: 10,
        invoicedQuantity: 10,
      }),
    ]);

    expect(countOccurrences(html, arrivalLine("Ya llegó a bodega"))).toBe(2);
    expect(countOccurrences(html, "Listo para entregar")).toBe(2);
  });

  it("la línea de llegada se parte en pantallas angostas, en tarjeta y tabla", () => {
    const html = render([pending({ availabilityStatus: "LLEGO_BODEGA" })]);
    const [card, table] = html.split("<table");

    for (const representation of [card, table]) {
      expect(representation).toMatch(
        /<p class="[^"]*whitespace-normal[^"]*break-words[^"]*">Ya llegó a bodega</,
      );
    }
  });

  it("dice Agotado junto al borde rojo en las dos vistas, en vez del texto de compras", () => {
    const html = render([pending({ purchaseStatus: "AGOTADO", inventoryReadyQuantity: 0 })], false);

    expect(countOccurrences(html, "border-l-danger")).toBe(2);
    expect(countOccurrences(html, SOLD_OUT_BADGE)).toBe(2);
    expect(html).not.toContain(PURCHASE_TEXT);
  });

  it("no dice Agotado en rojo cuando está listo: el amarillo gana y el texto de compras queda", () => {
    const html = render(
      [pending({ purchaseStatus: "AGOTADO", inventoryReadyQuantity: 6, invoicedQuantity: 0 })],
      false,
    );

    expect(countOccurrences(html, "Listo para facturar")).toBe(2);
    expect(html).not.toContain(SOLD_OUT_BADGE);
    expect(countOccurrences(html, PURCHASE_TEXT)).toBe(2);
  });

  it("deja igual el texto de compras que no es agotado", () => {
    const html = render([pending({ purchaseStatus: "SOLICITADO" })], false);

    expect(countOccurrences(html, 'text-xs text-muted-foreground">Solicitado</span>')).toBe(2);
  });
});
