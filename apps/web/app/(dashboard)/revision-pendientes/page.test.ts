import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getPendings: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
}));
vi.mock("@/server/services/pending.service", () => ({
  getPendings: mocks.getPendings,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCapability.mockResolvedValue(GERENCIA);
  mocks.getPendings.mockResolvedValue({ items: [], nextCursor: null });
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
