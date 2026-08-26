import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getPendingIdentityQueue: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
}));
vi.mock("@/server/services/pending.service", () => ({
  getPendingIdentityQueue: mocks.getPendingIdentityQueue,
}));

import RevisionIdentidadPendientesPage from "./page";

function searchParams(params: Record<string, string> = {}) {
  return Promise.resolve(params);
}

const GERENCIA = { user: { id: "admin-1", role: "ADMIN" } };
const BODEGA = { user: { id: "bodega-1", role: "BODEGA" } };

const ROW = {
  productId: "prod-1",
  productName: "Acetaminofén 500mg",
  productCode: "ACE-500",
  pendingCount: 4,
  identityVersion: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCapability.mockResolvedValue(GERENCIA);
  mocks.getPendingIdentityQueue.mockResolvedValue({ items: [], nextCursor: null });
});

describe("RevisionIdentidadPendientesPage · autorización", () => {
  // La lee QUIEN PUEDE RESOLVERLA: la misma capacidad que exige el servicio.
  // No se inventa una capacidad de módulo aparte, que sería una segunda matriz.
  it("guarda con canFixProductIdentity", async () => {
    await RevisionIdentidadPendientesPage({ searchParams: searchParams() });

    expect(mocks.requireCapability).toHaveBeenCalledWith("canFixProductIdentity");
  });

  it("corre el guard ANTES de tocar la cola", async () => {
    const order: string[] = [];
    mocks.requireCapability.mockImplementation(async () => {
      order.push("guard");
      return GERENCIA;
    });
    mocks.getPendingIdentityQueue.mockImplementation(async () => {
      order.push("query");
      return { items: [], nextCursor: null };
    });

    await RevisionIdentidadPendientesPage({ searchParams: searchParams() });

    expect(order).toEqual(["guard", "query"]);
  });

  // Un rechazo NO puede degradar a "cola vacía": el guard corta la página.
  // Si se filtrara una fila, el error de acceso habría revelado datos.
  it("no renderiza nada si el guard rechaza", async () => {
    mocks.requireCapability.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(
      RevisionIdentidadPendientesPage({ searchParams: searchParams() }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.getPendingIdentityQueue).not.toHaveBeenCalled();
  });

  // El FORBIDDEN del servicio se propaga; NO se traduce a lista vacía.
  it("propaga el rechazo del servicio en vez de mostrar la cola vacía", async () => {
    mocks.getPendingIdentityQueue.mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      RevisionIdentidadPendientesPage({ searchParams: searchParams() }),
    ).rejects.toThrow("FORBIDDEN");
  });
});

describe("RevisionIdentidadPendientesPage · alcance y cursor", () => {
  // El alcance lo decide el SERVICIO. La página entrega rol y usuario crudos y
  // no calcula `ownerId`: dos lugares decidiendo alcance es como se filtra.
  it("entrega rol y usuario sin resolver el alcance", async () => {
    mocks.requireCapability.mockResolvedValue(BODEGA);

    await RevisionIdentidadPendientesPage({ searchParams: searchParams() });

    expect(mocks.getPendingIdentityQueue).toHaveBeenCalledWith(
      expect.objectContaining({ role: "BODEGA", userId: "bodega-1" }),
    );
    const [args] = mocks.getPendingIdentityQueue.mock.calls[0] as [Record<string, unknown>];
    expect(args).not.toHaveProperty("ownerId");
  });

  it("pasa el cursor de la URL tal cual, sin decodificarlo", async () => {
    // Ver la nota del mismo fixture en `pending-identity-queue.render.test.ts`:
    // `:`, `/`, `+` y `%` delatan cualquier reinterpretación del cursor.
    const opaque = "7:prod-1/+op%20aco==";

    await RevisionIdentidadPendientesPage({ searchParams: searchParams({ cursor: opaque }) });

    expect(mocks.getPendingIdentityQueue).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: opaque }),
    );
  });
});

describe("RevisionIdentidadPendientesPage · render", () => {
  it("muestra las filas que devolvió el servicio", async () => {
    mocks.getPendingIdentityQueue.mockResolvedValue({ items: [ROW], nextCursor: null });

    const html = renderToStaticMarkup(
      await RevisionIdentidadPendientesPage({ searchParams: searchParams() }),
    );

    expect(html).toContain("Acetaminofén 500mg");
    expect(html).toContain("ACE-500");
  });

  it("arma el enlace de la página siguiente sobre esta ruta", async () => {
    mocks.getPendingIdentityQueue.mockResolvedValue({ items: [ROW], nextCursor: "sig" });

    const html = renderToStaticMarkup(
      await RevisionIdentidadPendientesPage({ searchParams: searchParams() }),
    );

    expect(html).toContain('href="/revision-identidad-pendientes?cursor=sig"');
  });
});
