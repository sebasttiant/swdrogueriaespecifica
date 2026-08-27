import { beforeEach, describe, expect, it, vi } from "vitest";

// `useActionState` es lo que trae el `{ ok, error }` de la Server Action al
// render. Lo mockeamos para poder fijar el estado devuelto y afirmar que el
// rechazo LLEGA A LA PANTALLA — antes los formularios lo descartaban.
const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

// Las Server Actions no corren en el render: solo tienen que existir para que
// `useActionState` las reciba. Mockearlas evita arrastrar "use server" y
// next/cache al entorno de test.
vi.mock("@/server/actions/pending.actions", () => ({
  deliverPendingAction: vi.fn(),
  cancelPendingAction: vi.fn(),
  updatePendingManagementStatusAction: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PendingListItem } from "@/server/repositories/pending.repository";

import { PendingList } from "./pending-list";
import { reviewPageHref, type ReviewAxes } from "./review-axes";

type ActionState = { error: string | null; ok: boolean };

const IDLE: ActionState = { error: null, ok: false };

function mockActionState(state: ActionState, isPending = false) {
  useActionStateMock.mockReturnValue([state, vi.fn(), isPending]);
}

function pending(overrides: Partial<PendingListItem> = {}): PendingListItem {
  return {
    id: "pend-1",
    quantity: 10,
    status: "PARCIAL",
    promisedAt: new Date("2026-07-10T18:00:00.000Z"),
    customerName: null,
    note: null,
    customerPhone: null,
    customerAddress: null,
    createdBy: null,
    zone: null,
    totalAmount: null,
    paidAmount: 0,
    createdAt: new Date("2026-07-09T10:00:00.000Z"),
    deliveredQuantity: 4,
    cancelledQuantity: 0,
    // Por defecto: un pendiente que nunca aplazó identidad, sobre un producto
    // legado sin código. Es el estado de la mayoría de las filas de hoy, y no
    // avisa nada — un producto sin código no es un aplazamiento.
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

function renderList(
  props: Partial<{
    canDeliver: boolean;
    canCancel: boolean;
    canManageStatus: boolean;
    items: PendingListItem[];
    nextCursor: string | null;
    scope: "active" | "history";
    axes: ReviewAxes;
  }> = {},
): string {
  const scope = props.scope ?? "active";
  const axes = props.axes ?? {};
  return renderToStaticMarkup(
    createElement(PendingList, {
      items: props.items ?? [pending()],
      nextCursor: props.nextCursor ?? null,
      canDeliver: props.canDeliver ?? true,
      canCancel: props.canCancel ?? true,
      canManageStatus: props.canManageStatus ?? false,
      scope,
      // La página es la que arma el enlace, porque es la única que conoce la
      // vista completa. Acá se usa el mismo constructor que en producción.
      pageHref: (cursor) => reviewPageHref({ scope, view: "detalle", axes, cursor }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActionState(IDLE);
});

describe("PendingList · scope-aware pagination", () => {
  // Si el link "Ver más" solo llevara el cursor, paginar dentro del historial
  // devolvería al usuario a la vista activa sin avisar: la página siguiente se
  // resolvería con el scope por defecto y mostraría otro conjunto de filas.
  it("carries the history scope into the next-page link", () => {
    const html = renderList({ nextCursor: "cursor-2", scope: "history" });

    expect(html).toContain("scope=history");
    expect(html).toContain("cursor=cursor-2");
  });

  it("omits the scope from the next-page link in the default active view", () => {
    const html = renderList({ nextCursor: "cursor-2", scope: "active" });

    expect(html).toContain("cursor=cursor-2");
    expect(html).not.toContain("scope=");
  });

  // Paginar no puede aflojar el filtro: la página siguiente tiene que mirar el
  // mismo conjunto que la primera, o el recorrido cambia a mitad de camino.
  it("carries the review axes into the next-page link", () => {
    const html = renderList({
      nextCursor: "cursor-2",
      axes: { purchase: "SOLICITADO", customer: "CONTACTADO" },
    });

    expect(html).toContain("purchase=SOLICITADO");
    expect(html).toContain("customer=CONTACTADO");
  });
});

describe("PendingList · action error contract", () => {
  it("surfaces the delivery rejection returned by the server action", () => {
    const message = "La cantidad supera lo que resta por entregar.";
    mockActionState({ error: message, ok: false });

    const html = renderList({ canCancel: false });

    expect(html).toContain('role="alert"');
    expect(html).toContain(message);
  });

  it("surfaces the cancellation rejection returned by the server action", () => {
    const message = "No se puede cancelar un pendiente ya entregado.";
    mockActionState({ error: message, ok: false });

    const html = renderList({ canDeliver: false });

    expect(html).toContain('role="alert"');
    expect(html).toContain(message);
  });

  it("renders no alert while the action has not rejected", () => {
    const html = renderList();

    expect(html).not.toContain('role="alert"');
  });

  it("wires both forms to the stateful actions, not to fire-and-forget wrappers", () => {
    renderList();

    // Una llamada a `useActionState` por formulario: entrega y cancelación.
    // Un wrapper `Promise<void>` no podría alimentar este hook.
    expect(useActionStateMock).toHaveBeenCalledTimes(2);
  });
});

describe("PendingList · capability gating and delivery bounds", () => {
  it("caps the delivery quantity at what is left and pre-fills it", () => {
    const html = renderList({ canCancel: false });

    // 10 pedidos - 4 entregados = 6 restantes. `max`/`value` son ayuda del
    // navegador; el límite real lo impone el service bajo el lock de fila.
    expect(html).toMatch(/id="quantity-pend-1"[^>]*max="6"/);
    expect(html).toMatch(/id="quantity-pend-1"[^>]*value="6"/);
  });

  it("renders only the granted controls", () => {
    expect(renderList({ canDeliver: true, canCancel: false })).not.toContain("Cancelar");
    expect(renderList({ canDeliver: false, canCancel: true })).not.toContain("Entregar");

    const both = renderList();
    expect(both).toContain("Entregar");
    expect(both).toContain("Cancelar");
  });

  it("hides both controls on a closed pending", () => {
    const html = renderList({ items: [pending({ status: "ENTREGADO", deliveredQuantity: 10 })] });

    expect(html).not.toContain("Entregar");
    expect(html).not.toContain("Cancelar");
  });

  it("disables the controls while the action is in flight", () => {
    mockActionState(IDLE, true);

    const html = renderList();

    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toMatch(/id="quantity-pend-1"[^>]*disabled/);
  });
});

describe("PendingList · estado de gestión (Mejora 2)", () => {
  // El vendedor (sin autoridad de compras) NUNCA ve el selector, ni siquiera en
  // un pendiente que sí lo admitiría.
  it("hides the management selector from users without purchasing authority", () => {
    const html = renderList({
      canManageStatus: false,
      items: [pending({ status: "PENDIENTE", deliveredQuantity: 0 })],
    });

    expect(html).not.toContain('name="status"');
  });

  // Los dos desenlaces reales a un toque; los intermedios siguen disponibles
  // pero plegados. Antes esto era un selector de cuatro opciones más "Aplicar".
  it("offers the two real outcomes to purchasing on an open pending", () => {
    const html = renderList({
      canManageStatus: true,
      items: [pending({ status: "PENDIENTE", deliveredQuantity: 0 })],
    });

    expect(html).toContain("Ya lo pedí");
    expect(html).toContain("Agotado");
    expect(html).toContain('name="status" value="SOLICITADO"');
    // Los intermedios existen, detrás de un gesto.
    expect(html).toContain("Otro estado");
    expect(html).not.toContain("Aplicar");
  });

  // PARCIAL ya tiene una entrega en curso: la gestión no aplica ni para gerencia.
  it("does not show the selector once the pending entered delivery (PARCIAL)", () => {
    const html = renderList({
      canManageStatus: true,
      items: [pending({ status: "PARCIAL", deliveredQuantity: 4 })],
    });

    expect(html).not.toContain('name="status"');
  });

  it("does not show the selector on a closed pending", () => {
    const html = renderList({
      canManageStatus: true,
      items: [pending({ status: "ENTREGADO", deliveredQuantity: 10 })],
    });

    expect(html).not.toContain('name="status"');
  });

  // Pedido de gerencia: "en ya pedido no debería salir todas las funciones, ya
  // está pedido". Un pendiente resuelto informa su estado y no vuelve a
  // preguntar; cambiarlo queda detrás de un gesto explícito.
  it("informs the settled status instead of asking again", () => {
    const html = renderList({
      canManageStatus: true,
      items: [pending({ status: "COTIZANDO", deliveredQuantity: 0 })],
    });

    expect(html).toContain("Cotizando");
    expect(html).toContain("cambiar");
    // No se vuelve a ofrecer el estado que ya tiene.
    expect(html).not.toContain('name="status" value="COTIZANDO"');
  });
});

describe("PendingList · seguimiento del cliente", () => {
  it("muestra la zona junto al cliente", () => {
    const html = renderList({
      items: [pending({ customerName: "Ana Pérez", zone: "Norte" })],
    });

    expect(html).toContain("Ana Pérez");
    expect(html).toContain("Norte");
  });

  // El saldo es lo que el operador tiene que COBRAR al entregar: va en la
  // tarjeta, no escondido detrás de un badge.
  it("muestra abono, total y saldo cuando el cliente abonó parte", () => {
    const html = renderList({
      items: [pending({ totalAmount: 50_000, paidAmount: 20_000 })],
    });

    // Los tres números tienen que estar: lo abonado, lo acordado y lo que falta.
    expect(html).toMatch(/Abonó[^<]*20\.000/);
    expect(html).toMatch(/de[^<]*50\.000/);
    expect(html).toMatch(/saldo[^<]*30\.000/);
  });

  it("marca como Pagado cuando el abono cubre el total", () => {
    const html = renderList({
      items: [pending({ totalAmount: 50_000, paidAmount: 50_000 })],
    });

    expect(html).toContain("Pagado");
    // Ya no hay nada que cobrar: no se anuncia un saldo.
    expect(html).not.toMatch(/saldo/i);
  });

  // Producto por cotizar: hay plata del cliente pero no un total acordado.
  it("nunca dice Pagado sin un total acordado", () => {
    const html = renderList({
      items: [pending({ totalAmount: null, paidAmount: 99_000 })],
    });

    expect(html).toContain("valor total sin acordar");
    expect(html).not.toContain(">Pagado<");
  });

  // Sin abono no se ensucia la tarjeta con un badge gris en cada fila.
  it("no muestra badge ni línea de pago cuando no hubo abono", () => {
    const html = renderList({ items: [pending({ totalAmount: null, paidAmount: 0 })] });

    expect(html).not.toContain("Abonó");
    expect(html).not.toContain(">Pagado<");
  });
});

describe("PendingList · dirección de entrega", () => {
  it("muestra la dirección cuando el pendiente la tiene", () => {
    const html = renderList({
      items: [pending({ customerAddress: "Calle 10 #43-20" })],
    });

    expect(html).toContain("Calle 10 #43-20");
  });

  it("no muestra la línea de dirección cuando está vacía", () => {
    const html = renderList({ items: [pending({ customerAddress: null })] });

    expect(html).not.toContain("Dirección:");
  });
});

describe("PendingList · cantidades con semántica T2.2b (T4.2b·B)", () => {
  // La línea de entrega explica la ecuación del cierre parcial: antes un
  // CLOSED_PARTIAL (5 pedidos, 3 entregados, 2 cancelados) decía
  // "Entregado: 3 / 5" y los 2 que el cliente no espera quedaban mudos.
  it("cierre parcial: muestra lo entregado y lo cancelado", () => {
    const html = renderList({
      items: [pending({ status: "CLOSED_PARTIAL", quantity: 5, deliveredQuantity: 3, cancelledQuantity: 2 })],
    });

    expect(html).toContain("Entregado: 3 de 5");
    expect(html).toContain("cancelado: 2");
  });

  it("cierre parcial: no usa la semántica vieja 'X / Y'", () => {
    const html = renderList({
      items: [pending({ status: "CLOSED_PARTIAL", quantity: 5, deliveredQuantity: 3, cancelledQuantity: 2 })],
    });

    expect(html).not.toContain("3 / 5");
  });

  it("cancelado: no dice que se entregó algo", () => {
    const html = renderList({
      items: [pending({ status: "CANCELADO", quantity: 5, deliveredQuantity: 0, cancelledQuantity: 0 })],
    });

    expect(html).toContain("Cancelado");
    expect(html).not.toContain("Entregado:");
  });

  it("entregado completo: lo dice sin mencionar cancelados", () => {
    const html = renderList({
      items: [pending({ status: "ENTREGADO", quantity: 5, deliveredQuantity: 5, cancelledQuantity: 0 })],
    });

    expect(html).toContain("Entregado: 5 de 5");
  });
});

describe("PendingList · historial con evidencia de cierre (T4.3)", () => {
  // El historial audita CÓMO se cerró, no solo que se cerró. La tarjeta de un
  // ENTREGADO dice quién entregó y cuándo; la de un CANCELADO, quién, cuándo y
  // el motivo. Sin esto, history es un estado sin historia.
  it("entregado: muestra quién entregó", () => {
    const html = renderList({
      scope: "history",
      items: [
        pending({
          status: "ENTREGADO",
          deliveredQuantity: 5,
          cancelledQuantity: 0,
          completedAt: new Date("2026-07-10T17:30:00.000Z"),
          deliveries: [
            {
              id: "del-1",
              quantity: 5,
              deliveredAt: new Date("2026-07-10T17:30:00.000Z"),
              deliveredBy: { id: "seller-1", name: "Ana" },
            },
          ],
        }),
      ],
    });

    expect(html).toContain("Entregado por Ana");
    expect(html).not.toContain("Cancelado por");
  });

  it("cancelado: muestra quién, cuándo y el motivo", () => {
    const html = renderList({
      scope: "history",
      items: [
        pending({
          status: "CANCELADO",
          deliveredQuantity: 0,
          cancelledQuantity: 0,
          cancelledAt: new Date("2026-07-11T09:00:00.000Z"),
          cancelledBy: { id: "seller-2", name: "Luis" },
          cancelReason: "El cliente ya no lo necesita",
        }),
      ],
    });

    expect(html).toContain("Cancelado por Luis");
    expect(html).toContain("El cliente ya no lo necesita");
  });

  it("cierre parcial: muestra la fecha de cierre", () => {
    const html = renderList({
      scope: "history",
      items: [
        pending({
          status: "CLOSED_PARTIAL",
          deliveredQuantity: 3,
          cancelledQuantity: 2,
          completedAt: new Date("2026-07-12T11:00:00.000Z"),
        }),
      ],
    });

    expect(html).toContain("Cerrado el");
  });

  it("pendiente abierto: no inventa una línea de cierre", () => {
    const html = renderList({
      scope: "active",
      items: [pending({ status: "PENDIENTE", deliveredQuantity: 0, cancelledQuantity: 0 })],
    });

    expect(html).not.toContain("Cancelado por");
    expect(html).not.toContain("Entregado por");
    expect(html).not.toContain("Cerrado el");
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
describe("PendingList · el nombre no se corta en el celular", () => {
  it("no aplica `truncate` a ningún dato de la tarjeta", () => {
    const html = renderList({ nextCursor: null, scope: "active" });

    expect(html).not.toContain("truncate");
  });
});

// --------------------------------------------------------------------------
// El aviso de llegada, en la pantalla donde se revisa la cola.
//
// `fulfillmentNotice` existía solo en la vista Listado. `/revision-pendientes`
// usa ESTA lista, así que un pendiente cuya mercancía ya llegó se veía
// exactamente igual que uno que sigue esperando: el sistema sabía que se podía
// facturar y no se lo decía a nadie en la pantalla donde se toman esas
// decisiones.
//
// Son los dos momentos distintos que ya distinguía la otra vista: la mercancía
// llegó a la droguería (todavía no se puede facturar) y bodega la cargó al
// sistema (ya se puede).
// --------------------------------------------------------------------------
describe("PendingList · aviso de llegada", () => {
  it("anuncia que la mercancía llegó a la droguería y sigue sin cargar", () => {
    const html = renderList({
      items: [pending({ availabilityStatus: "LLEGO_BODEGA", customerStatus: "CONTACTADO" })],
    });

    expect(html).toContain("Llegó a la droguería");
  });

  it("anuncia que ya se puede facturar cuando bodega cargó la mercancía", () => {
    const html = renderList({
      items: [
        pending({ inventoryReadyQuantity: 10, quantity: 10, customerStatus: "CONTACTADO" }),
      ],
    });

    expect(html).toContain("Cargado");
  });

  it("dice cuánto llegó cuando bodega cargó solo una parte", () => {
    const html = renderList({
      items: [
        pending({ inventoryReadyQuantity: 4, quantity: 10, customerStatus: "CONTACTADO" }),
      ],
    });

    // "4 de 10" a secas ya lo imprime la línea "Entregado: 4 de 10 unidad" de
    // la tarjeta: afirmarlo suelto pasaría sin que el aviso exista.
    expect(html).toContain("Cargado: 4 de 10");
  });

  it("calla sobre un pendiente ya cerrado: no queda nada que facturar", () => {
    const html = renderList({
      items: [
        pending({
          status: "ENTREGADO",
          customerStatus: "ENTREGADO",
          inventoryReadyQuantity: 10,
        }),
      ],
    });

    expect(html).not.toContain("Cargado");
  });
});

// --------------------------------------------------------------------------
// S2b · 1e-E — el aviso de identidad pendiente en la vista detallada.
//
// El aviso es DERIVADO del estado actual del producto: no hay columna que
// diga "avisar", no hay booleano que alguien tenga que apagar. Por eso no
// puede quedar encendido sobre un producto ya identificado.
// --------------------------------------------------------------------------
describe("PendingList · identidad pendiente", () => {
  it("avisa cuando se aplazó la identidad y el producto sigue sin código", () => {
    const html = renderList({
      items: [pending({ identitySkippedReason: "ORION_UNAVAILABLE" })],
    });

    expect(html).toContain("Identidad pendiente");
  });

  it("no avisa una vez que el producto recibió su código", () => {
    const html = renderList({
      items: [
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
      ],
    });

    expect(html).not.toContain("Identidad pendiente");
  });

  it("no avisa por un producto sin código que nadie aplazó", () => {
    const html = renderList({ items: [pending()] });

    expect(html).not.toContain("Identidad pendiente");
  });

  // El aviso tiene que LEERSE, no adivinarse por el color. Estas filas se
  // miran en un celular al sol y las lee gente que puede no distinguir tonos.
  it("dice el aviso con texto, no solo con un color", () => {
    const html = renderList({
      items: [pending({ identitySkippedReason: "CODE_NOT_FOUND" })],
    });

    // El texto viaja en el DOM, así que un lector de pantalla lo anuncia.
    expect(html).toContain(">Identidad pendiente<");
  });
});
