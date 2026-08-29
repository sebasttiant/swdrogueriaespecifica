import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getPendings: vi.fn(),
  listPendingReception: vi.fn(),
  countPendingReception: vi.fn(),
  listStockoutProducts: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
}));
vi.mock("@/server/services/pending.service", () => ({
  getPendings: mocks.getPendings,
}));
vi.mock("@/server/services/pending-reception.service", () => ({
  listPendingReception: mocks.listPendingReception,
  countPendingReception: mocks.countPendingReception,
}));
vi.mock("@/server/services/stockout.service", () => ({
  listStockoutProducts: mocks.listStockoutProducts,
}));

import RevisionPendientesPage from "./page";

function searchParams(params: Record<string, string> = {}) {
  return Promise.resolve(params);
}

// `can` NO se mockea a propósito: queremos que el test ejercite la matriz real
// de capacidades. Si mañana alguien le saca `canManageAllPendings` a SUPERVISOR,
// este test tiene que enterarse.
const VENDEDOR = { user: { id: "vendedor-1", role: "OPERADOR" } };
const GERENCIA = { user: { id: "admin-1", role: "ADMIN" } };
const SUPERVISION = { user: { id: "supervisor-1", role: "SUPERVISOR" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCapability.mockResolvedValue(GERENCIA);
  mocks.getPendings.mockResolvedValue({ items: [], nextCursor: null });
  mocks.listPendingReception.mockResolvedValue([]);
  mocks.countPendingReception.mockResolvedValue(0);
  mocks.listStockoutProducts.mockResolvedValue([]);
});

describe("RevisionPendientesPage · autorización", () => {
  it("guarda con canReviewPendings", async () => {
    await RevisionPendientesPage({ searchParams: searchParams() });

    expect(mocks.requireCapability).toHaveBeenCalledWith("canReviewPendings");
  });

  // El orden importa: con el guard después de la consulta, un rol sin permiso
  // tendría los pendientes en memoria durante todo lo que tarde la query.
  it("corre el guard ANTES de tocar los pendientes", async () => {
    const order: string[] = [];
    mocks.requireCapability.mockImplementation(async () => {
      order.push("guard");
      return GERENCIA;
    });
    mocks.getPendings.mockImplementation(async () => {
      order.push("query");
      return { items: [], nextCursor: null };
    });

    await RevisionPendientesPage({ searchParams: searchParams() });

    expect(order).toEqual(["guard", "query"]);
  });

  it("no consulta cuando el guard rechaza", async () => {
    mocks.requireCapability.mockRejectedValue(new Error("REDIRECT:/dashboard"));

    await expect(
      RevisionPendientesPage({ searchParams: searchParams() }),
    ).rejects.toThrow("REDIRECT:/dashboard");
    expect(mocks.getPendings).not.toHaveBeenCalled();
  });
});

// El recorte por dueño YA EXISTE en `listPendings` (`ownerId`) y ya está probado
// contra PostgreSQL real. Estos tests NO lo reconstruyen: prueban que la ruta
// nueva lo REUSA. Sin esto, un módulo de revisión podría listar los pendientes
// de todos a un vendedor, que es exactamente la fuga que el recorte evita.
describe("RevisionPendientesPage · alcance por rol", () => {
  it("al vendedor le acota los pendientes a los suyos", async () => {
    mocks.requireCapability.mockResolvedValue(VENDEDOR);

    await RevisionPendientesPage({ searchParams: searchParams() });

    expect(mocks.getPendings).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "vendedor-1" }),
    );
  });

  it("a gerencia no le acota nada: ve los de todos", async () => {
    mocks.requireCapability.mockResolvedValue(GERENCIA);

    await RevisionPendientesPage({ searchParams: searchParams() });

    expect(mocks.getPendings).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: undefined }),
    );
  });

  it("a la supervisión tampoco: revisa la cola entera", async () => {
    // Faltaba, y es el rol del que depende la revisión diaria. Sin este caso,
    // quitarle el alcance global a la supervisión no rompía nada acá.
    mocks.requireCapability.mockResolvedValue(SUPERVISION);

    await RevisionPendientesPage({ searchParams: searchParams() });

    expect(mocks.getPendings).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: undefined }),
    );
  });

  // La identidad del cliente se minimiza en el boundary según el rol, nunca en
  // la pantalla. El flag es obligatorio en `getPendings` justamente para que
  // olvidarlo sea un error de tipos y no una fuga silenciosa.
  it("decide la visibilidad de la identidad del cliente en el servidor", async () => {
    mocks.requireCapability.mockResolvedValue(VENDEDOR);

    await RevisionPendientesPage({ searchParams: searchParams() });

    expect(mocks.getPendings).toHaveBeenCalledWith(
      expect.objectContaining({ canViewCustomerIdentity: expect.any(Boolean) }),
    );
  });
});

describe("RevisionPendientesPage · ejes de revisión", () => {
  it("ofrece los tres ejes", async () => {
    // El componente es async: se resuelve primero y se renderiza el elemento
    // que devuelve. `renderToStaticMarkup` no sabe esperar una promesa.
    const element = await RevisionPendientesPage({ searchParams: searchParams() });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Compras");
    expect(html).toContain("Disponibilidad");
    expect(html).toContain("Cliente");
  });

  // Regresión: `reviewHref` arma los enlaces sobre `/pendientes` por defecto.
  // Sin pasarle la ruta de este módulo, el primer clic en cualquier filtro
  // expulsaba al usuario a la cola operativa. Aseverar que los ejes SE PINTAN
  // no alcanzaba: hay que aseverar A DÓNDE APUNTAN.
  it("los filtros apuntan a este módulo, no devuelven a la cola operativa", async () => {
    const element = await RevisionPendientesPage({ searchParams: searchParams() });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('href="/revision-pendientes?');
    expect(html).not.toContain('href="/pendientes?');
    expect(html).not.toContain('href="/pendientes"');
  });

  it("reenvía un eje de la URL a la consulta, no lo filtra en la pantalla", async () => {
    await RevisionPendientesPage({
      searchParams: searchParams({ purchase: "SOLICITADO" }),
    });

    expect(mocks.getPendings).toHaveBeenCalledWith(
      expect.objectContaining({ axes: { purchase: "SOLICITADO" } }),
    );
  });
});


// --------------------------------------------------------------------------
// LA MITAD FÍSICA: donde BODEGA trabaja los pedidos de clientes.
//
// Regla de negocio del 29-08-2026: el pendiente NACE SOLICITADO. Cuando el
// vendedor lo registra, el cliente ya pidió el producto. No hace falta que
// gerencia apriete "Pedido" para que bodega lo vea — ese botón responde a otra
// pregunta ("¿se lo pedimos al proveedor?") y atarle la recepción hacía que el
// pedido de un cliente no le llegara nunca a bodega.
// --------------------------------------------------------------------------
describe("RevisionPendientesPage · la mitad física", () => {
  function fila(overrides: Record<string, unknown> = {}) {
    return {
      id: "mi-1",
      pendingId: "pend-1",
      productId: "prod-1",
      productName: "Glucerna",
      orionCode: "1020",
      unit: "unidad",
      laboratoryName: "MK",
      requestedLaboratoryName: null,
      requestedQuantity: 12,
      reservedQuantity: 0,
      outstandingQuantity: 12,
      hasArrived: false,
      arrivedByName: null,
      arrivedAt: null,
      requestedAt: new Date("2026-08-25T14:00:00Z"),
      ...overrides,
    };
  }

  it("consulta la cola física al abrir abastecimiento", async () => {
    await RevisionPendientesPage({
      searchParams: searchParams({ tab: "abastecimiento" }),
    });

    expect(mocks.listPendingReception).toHaveBeenCalled();
  });

  // El contador va aunque la pestaña esté cerrada: un número que solo se
  // calcula al entrar no avisa de nada.
  it("cuenta aun estando en seguimiento", async () => {
    await RevisionPendientesPage({ searchParams: searchParams() });

    expect(mocks.countPendingReception).toHaveBeenCalled();
    expect(mocks.listPendingReception).not.toHaveBeenCalled();
  });

  it("no consulta los pendientes cuando se está en la mitad física", async () => {
    await RevisionPendientesPage({
      searchParams: searchParams({ tab: "abastecimiento" }),
    });

    expect(mocks.getPendings).not.toHaveBeenCalled();
  });

  // EL TEST DE LA REGLA. Sin botón de "Pedido": el pendiente ya nació pedido
  // por el cliente. Si alguien vuelve a colgar esa acción acá, confunde otra
  // vez "pedido por el cliente" con "pedido al proveedor".
  it("NO ofrece marcar el pendiente como pedido", async () => {
    mocks.listPendingReception.mockResolvedValue([fila()]);

    const html = renderToStaticMarkup(
      await RevisionPendientesPage({ searchParams: searchParams({ tab: "abastecimiento" }) }),
    );

    expect(html).not.toContain("Marcar Glucerna como pedido");
    expect(html).not.toContain("Descartar Glucerna");
  });

  // BODEGA es la responsable habitual; ADMIN y SUPERADMIN el respaldo. Los tres
  // tienen `canReceiveMissingItems`.
  it.each(["BODEGA", "ADMIN", "SUPERADMIN"] as const)(
    "%s puede marcar la llegada",
    async (role) => {
      mocks.requireCapability.mockResolvedValue({ user: { id: "u-1", role } });
      mocks.listPendingReception.mockResolvedValue([fila()]);

      const html = renderToStaticMarkup(
        await RevisionPendientesPage({ searchParams: searchParams({ tab: "abastecimiento" }) }),
      );

      expect(html).toContain("Ya llegó");
    },
  );

  // El vendedor MIRA —es su cliente el que espera— pero no marca llegadas ni
  // carga entradas. La negativa real vive en el servidor; esto solo evita
  // ofrecer un control que después se rechaza.
  it.each(["OPERADOR", "SUPERVISOR"] as const)(
    "%s ve el estado pero no puede marcar la llegada",
    async (role) => {
      mocks.requireCapability.mockResolvedValue({ user: { id: "u-1", role } });
      mocks.listPendingReception.mockResolvedValue([fila()]);

      const html = renderToStaticMarkup(
        await RevisionPendientesPage({ searchParams: searchParams({ tab: "abastecimiento" }) }),
      );

      expect(html).toContain("Glucerna");
      expect(html).not.toContain("Ya llegó");
    },
  );

  // Ya llegó ≠ podés facturar. Entre los dos hay un paso —cargar la entrada— y
  // la pantalla tiene que decirlo con esas palabras.
  it("una fila que ya llegó ofrece registrar la entrada, no facturar", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "u-1", role: "BODEGA" } });
    mocks.listPendingReception.mockResolvedValue([
      fila({ hasArrived: true, arrivedByName: "Bodeguero", arrivedAt: new Date() }),
    ]);

    const html = renderToStaticMarkup(
      await RevisionPendientesPage({ searchParams: searchParams({ tab: "abastecimiento" }) }),
    );

    expect(html).toContain("Llegó · sin cargar");
    expect(html).toContain("Registrar entrada");
    // Y la auditoría a la vista: quién recibió.
    expect(html).toContain("Bodeguero");
    expect(html).not.toContain("Facturar");
  });

  // La minimización vive en el servicio, pero la pantalla tampoco debe pintar
  // lo que no le llega. El tipo de la fila no tiene campo de cliente.
  it("la mitad física no muestra datos del cliente", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "u-1", role: "BODEGA" } });
    mocks.listPendingReception.mockResolvedValue([fila()]);

    const html = renderToStaticMarkup(
      await RevisionPendientesPage({ searchParams: searchParams({ tab: "abastecimiento" }) }),
    );

    expect(html).not.toContain("customerName");
    expect(html).not.toContain("customerPhone");
  });

  it("muestra lo reservado junto a lo que falta, para no leerse como cero", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "u-1", role: "BODEGA" } });
    mocks.listPendingReception.mockResolvedValue([
      fila({ reservedQuantity: 4, outstandingQuantity: 8 }),
    ]);

    const html = renderToStaticMarkup(
      await RevisionPendientesPage({ searchParams: searchParams({ tab: "abastecimiento" }) }),
    );

    expect(html).toContain("4 de 12 ya reservadas");
  });
});
