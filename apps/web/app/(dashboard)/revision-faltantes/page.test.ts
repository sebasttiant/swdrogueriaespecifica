import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getMissingReportQueue: vi.fn(),
  listReceiverQueue: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
}));
vi.mock("@/server/services/missing-report.service", () => ({
  getMissingReportQueue: mocks.getMissingReportQueue,
}));
vi.mock("@/server/services/missing-receiver.service", async (original) => {
  const actual = await original<
    typeof import("@/server/services/missing-receiver.service")
  >();
  return { ...actual, listReceiverQueue: mocks.listReceiverQueue };
});

import { MAX_REVIEW_QUEUE_PAGE } from "@/features/faltantes/report-queue-paging";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";

import RevisionFaltantesPage from "./page";

function searchParams(params: { page?: string; scope?: string } = {}) {
  return Promise.resolve(params);
}

/** La sesión que entra a la ruta. El rol decide qué proyección se arma. */
function sesion(role: "ADMIN" | "BODEGA") {
  mocks.requireCapability.mockResolvedValue({ user: { id: "u-1", role } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCapability.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
  mocks.getMissingReportQueue.mockResolvedValue({ groups: [], hasMore: false, page: 1 });
  mocks.listReceiverQueue.mockResolvedValue([]);
});

describe("RevisionFaltantesPage · authorization", () => {
  // El guard de ENTRADA usa la capability más débil de las dos que abren la
  // ruta: gerencia entra por revisión, bodega por recepción. La proyección la
  // decide después el rol. Pedir la fuerte acá le cerraría la puerta a bodega
  // al mismo módulo que sí puede usar.
  it("guards with canReceiveMissingItems", async () => {
    await RevisionFaltantesPage({ searchParams: searchParams() });

    expect(mocks.requireCapability).toHaveBeenCalledWith("canReceiveMissingItems");
  });

  // El orden importa: sin esto, mover el guard después del fetch expondría la
  // cola a un rol sin permiso durante el tiempo que tarde la consulta.
  it("runs the guard BEFORE touching the queue", async () => {
    const order: string[] = [];
    mocks.requireCapability.mockImplementation(async () => {
      order.push("guard");
      return { user: { id: "admin-1", role: "ADMIN" } };
    });
    mocks.getMissingReportQueue.mockImplementation(async () => {
      order.push("query");
      return { groups: [], hasMore: false, page: 1 };
    });

    await RevisionFaltantesPage({ searchParams: searchParams() });

    expect(order).toEqual(["guard", "query"]);
  });

  it("does not query the queue when the guard rejects", async () => {
    mocks.requireCapability.mockRejectedValue(new Error("REDIRECT:/dashboard"));

    await expect(
      RevisionFaltantesPage({ searchParams: searchParams() }),
    ).rejects.toThrow("REDIRECT:/dashboard");
    expect(mocks.getMissingReportQueue).not.toHaveBeenCalled();
  });
});

describe("RevisionFaltantesPage · page param", () => {
  it("defaults to the first page and the project page size", async () => {
    await RevisionFaltantesPage({ searchParams: searchParams() });

    expect(mocks.getMissingReportQueue).toHaveBeenCalledWith({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      scope: "pending",
    });
  });

  it("forwards a valid page number", async () => {
    await RevisionFaltantesPage({ searchParams: searchParams({ page: "4" }) });

    expect(mocks.getMissingReportQueue).toHaveBeenCalledWith({
      page: 4,
      pageSize: DEFAULT_PAGE_SIZE,
      scope: "pending",
    });
  });

  // El param crudo NUNCA llega al service: pasa siempre por el parser, que lo
  // sanea. Sin esto, un `?page=-5` o `?page=abc` viajaría hasta la consulta.
  it("never passes the raw param through: junk and negatives are sanitized", async () => {
    for (const raw of ["abc", "-5", "0", "NaN"]) {
      mocks.getMissingReportQueue.mockClear();
      await RevisionFaltantesPage({ searchParams: searchParams({ page: raw }) });

      expect(mocks.getMissingReportQueue).toHaveBeenCalledWith({
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        scope: "pending",
      });
    }
  });

  it("caps an absurd page instead of forwarding a huge offset", async () => {
    await RevisionFaltantesPage({
      searchParams: searchParams({ page: "999999999999" }),
    });

    expect(mocks.getMissingReportQueue).toHaveBeenCalledWith({
      page: MAX_REVIEW_QUEUE_PAGE,
      pageSize: DEFAULT_PAGE_SIZE,
      scope: "pending",
    });
  });
});

// --------------------------------------------------------------------------
// Una ruta, dos proyecciones.
//
// Bodega entra al MISMO módulo que gerencia —no a una pantalla paralela con
// otro nombre— pero ve la cola de recepción, que sale de `MissingItem` y no de
// los reportes provisionales. Mezclarlas haría que bodega marque llegadas sobre
// mercadería que compras todavía no pidió.
// --------------------------------------------------------------------------
describe("RevisionFaltantesPage · proyección por rol", () => {
  it("BODEGA recibe la cola de recepción, nunca la de reportes", async () => {
    sesion("BODEGA");

    await RevisionFaltantesPage({ searchParams: searchParams() });

    expect(mocks.listReceiverQueue).toHaveBeenCalledWith("PEDIDO");
    expect(mocks.getMissingReportQueue).not.toHaveBeenCalled();
  });

  it("BODEGA puede abrir 'En bodega'", async () => {
    sesion("BODEGA");

    await RevisionFaltantesPage({ searchParams: searchParams({ scope: "arrived" }) });

    expect(mocks.listReceiverQueue).toHaveBeenCalledWith("EN_BODEGA");
  });

  // Esconder las pestañas no alcanza: quien escribe la URL a mano tiene que
  // caer en la cola permitida, y la consulta jamás debe pedir los estados de
  // compras.
  it.each(["pending", "discarded", "inventado"])(
    "un scope de compras escrito a mano (%s) cae en 'Ya pedidos'",
    async (scope) => {
      sesion("BODEGA");

      await RevisionFaltantesPage({ searchParams: searchParams({ scope }) });

      expect(mocks.listReceiverQueue).toHaveBeenCalledWith("PEDIDO");
      expect(mocks.getMissingReportQueue).not.toHaveBeenCalled();
    },
  );

  it("gerencia conserva la cola de reportes completa", async () => {
    sesion("ADMIN");

    await RevisionFaltantesPage({ searchParams: searchParams() });

    expect(mocks.getMissingReportQueue).toHaveBeenCalled();
    expect(mocks.listReceiverQueue).not.toHaveBeenCalled();
  });
});
