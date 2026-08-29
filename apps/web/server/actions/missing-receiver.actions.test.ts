import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  markMissingItemArrived: vi.fn(),
  recordAudit: vi.fn(),
  auditContextFromHeaders: vi.fn(),
  revalidatePath: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
}));
vi.mock("@/lib/db/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/server/repositories/missing-item.repository", () => ({
  markMissingItemArrived: mocks.markMissingItemArrived,
}));
vi.mock("@/server/services/audit.service", () => ({
  recordAudit: mocks.recordAudit,
  auditContextFromHeaders: mocks.auditContextFromHeaders,
}));

import { markMissingItemArrivedAction } from "./missing-receiver.actions";

// --------------------------------------------------------------------------
// "Ya llegó a bodega" mueve el faltante de PEDIDO a EN_BODEGA. Nada más.
//
// No crea inventario y no avisa al vendedor: notificarle "ya llegó" cuando
// todavía no puede entregar nada lo mandaría a llamar a un cliente que va a
// venir a buscar algo que el sistema no tiene.
// --------------------------------------------------------------------------

const PREV = { error: null, ok: false };

function formData(id: unknown = "mi-1") {
  const data = new FormData();
  if (typeof id === "string") data.set("missingItemId", id);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCapability.mockResolvedValue({
    user: { id: "bodega-1", role: "BODEGA" },
  });
  mocks.auditContextFromHeaders.mockResolvedValue({ userId: "bodega-1" });
  mocks.recordAudit.mockResolvedValue({ ok: true });
  mocks.markMissingItemArrived.mockResolvedValue(1);
  mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
});

describe("markMissingItemArrivedAction · autorización", () => {
  it("exige la capability de recepción antes de tocar nada", async () => {
    await markMissingItemArrivedAction(PREV, formData());

    expect(mocks.requireCapability).toHaveBeenCalledWith("canReceiveMissingItems");
  });

  // El actor sale de la SESIÓN. Aceptar un `arrivedById` del formulario
  // permitiría firmar la recepción a nombre de otro, y quién recibió qué es
  // justamente lo que este registro existe para conservar.
  it("el actor sale de la sesión, no del formulario", async () => {
    const data = formData();
    data.set("arrivedById", "otro-usuario");

    await markMissingItemArrivedAction(PREV, data);

    expect(mocks.markMissingItemArrived).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ arrivedById: "bodega-1" }),
    );
  });

  it("ignora un productId que el cliente intente mandar", async () => {
    const data = formData();
    data.set("productId", "prod-falso");

    await markMissingItemArrivedAction(PREV, data);

    const [, args] = mocks.markMissingItemArrived.mock.calls[0]!;
    expect(Object.keys(args as object)).toEqual(["id", "arrivedById", "arrivedAt"]);
  });
});

describe("markMissingItemArrivedAction · transición", () => {
  it("marca la llegada y revalida la cola", async () => {
    const result = await markMissingItemArrivedAction(PREV, formData("mi-9"));

    expect(result.ok).toBe(true);
    expect(mocks.markMissingItemArrived).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "mi-9" }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/revision-faltantes");
  });

  it("corre dentro de una transacción", async () => {
    await markMissingItemArrivedAction(PREV, formData());

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  // `0` es la respuesta del compare-and-set: la fila ya no estaba en PEDIDO.
  // Puede que otro la marcara primero —dos personas descargando el mismo
  // pedido— o que nunca se compró. El estado que hay es el correcto y no se
  // pisa.
  it("un conflicto no pisa el estado y lo explica", async () => {
    mocks.markMissingItemArrived.mockResolvedValue(0);

    const result = await markMissingItemArrivedAction(PREV, formData());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ya no está esperando/i);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("no audita un cambio que no ocurrió", async () => {
    mocks.markMissingItemArrived.mockResolvedValue(0);

    await markMissingItemArrivedAction(PREV, formData());

    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rechaza sin id, sin tocar la base", async () => {
    const result = await markMissingItemArrivedAction(PREV, formData(null));

    expect(result.ok).toBe(false);
    expect(mocks.markMissingItemArrived).not.toHaveBeenCalled();
  });
});

describe("markMissingItemArrivedAction · auditoría", () => {
  it("registra quién recibió y cuándo", async () => {
    await markMissingItemArrivedAction(PREV, formData("mi-7"));

    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "missing.arrived",
        entity: "MissingItem",
        entityId: "mi-7",
      }),
    );
    expect(mocks.auditContextFromHeaders).toHaveBeenCalledWith("bodega-1");
  });

  // La caja está en el depósito con o sin registro del evento: un fallo de
  // auditoría no puede tumbar una recepción ya escrita.
  it("un fallo de auditoría no tumba la recepción", async () => {
    mocks.recordAudit.mockRejectedValue(new Error("auditoría caída"));

    const result = await markMissingItemArrivedAction(PREV, formData());

    expect(result.ok).toBe(true);
  });
});
