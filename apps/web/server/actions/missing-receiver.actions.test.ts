import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  markMissingItemArrived: vi.fn(),
  recordAudit: vi.fn(),
  auditContextFromHeaders: vi.fn(),
  revalidatePath: vi.fn(),
  transaction: vi.fn(),
  findMissingItem: vi.fn(),
  enqueueArrival: vi.fn(),
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
vi.mock("@/server/services/notification-outbox.service", () => ({
  enqueuePendingArrivalNotification: mocks.enqueueArrival,
}));

import { markMissingItemArrivedAction } from "./missing-receiver.actions";

// --------------------------------------------------------------------------
// "Ya llegó" registra la llegada FÍSICA y avisa. Nada más.
//
// NO crea inventario y NO habilita facturar: entre la llegada y la venta está
// el registro de la entrada, que es el que asigna stock. El aviso lo dice con
// esas palabras —"llegó a la droguería, todavía sin cargar"— porque prometerle
// al cliente que puede pasar a buscarlo cuando el sistema no tiene nada
// asignado es exactamente el error que este aviso separado evita.
//
// La alerta de "podés facturar" es OTRO evento y lo emite la entrada.
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
  mocks.enqueueArrival.mockResolvedValue({ id: "outbox-1" });
  // Por defecto la fila viene de un PENDIENTE: es el caso que la regla nueva
  // habilita —el pendiente nace solicitado— y el que emite el aviso.
  mocks.findMissingItem.mockResolvedValue({ originId: "pending-1" });
  mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({ missingItem: { findUnique: mocks.findMissingItem } }),
  );
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

// --------------------------------------------------------------------------
// ALERTA 1 — LA LLEGADA FÍSICA.
//
// Es un evento propio, distinto del de disponibilidad. Dice "la caja está en la
// droguería", no "podés facturar": entre los dos está el registro de la
// entrada. Confundirlos hace que el vendedor le prometa al cliente algo que el
// sistema todavía no puede cumplir.
// --------------------------------------------------------------------------
describe("markMissingItemArrivedAction · aviso de llegada", () => {
  it("avisa al dueño del pendiente cuando la mercadería llega", async () => {
    await markMissingItemArrivedAction(PREV, formData("mi-1"));

    expect(mocks.enqueueArrival).toHaveBeenCalledWith("pending-1", expect.anything());
  });

  // DENTRO de la transacción: si la marca se revierte, el aviso se revierte con
  // ella. Un aviso que sobrevive al hecho que lo causó es peor que no avisar.
  it("encola el aviso dentro de la misma transacción que la marca", async () => {
    const orden: string[] = [];
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      orden.push("abre-tx");
      const salida = await fn({ missingItem: { findUnique: mocks.findMissingItem } });
      orden.push("cierra-tx");
      return salida;
    });
    mocks.enqueueArrival.mockImplementation(async () => {
      orden.push("encola");
      return { id: "outbox-1" };
    });

    await markMissingItemArrivedAction(PREV, formData("mi-1"));

    expect(orden).toEqual(["abre-tx", "encola", "cierra-tx"]);
  });

  // Una reposición de estantería no tiene cliente esperando: no hay a quién
  // avisarle.
  it("no avisa cuando la fila es de estantería", async () => {
    mocks.findMissingItem.mockResolvedValue({ originId: null });

    await markMissingItemArrivedAction(PREV, formData("mi-2"));

    expect(mocks.enqueueArrival).not.toHaveBeenCalled();
  });

  // Si el compare-and-set no movió nada —otro la marcó primero— no hubo
  // llegada nueva que anunciar.
  it("no avisa si la llegada no cambió nada", async () => {
    mocks.markMissingItemArrived.mockResolvedValue(0);

    const result = await markMissingItemArrivedAction(PREV, formData("mi-3"));

    expect(result.ok).toBe(false);
    expect(mocks.enqueueArrival).not.toHaveBeenCalled();
  });

  // Idempotencia: la garantía real vive en el outbox —la clave de transición es
  // el estado alcanzado—, pero acá se fija que la acción no invente una clave
  // por intento, que es como se rompería el dedupe sin que ninguna prueba lo note.
  it("repetir la marca no inventa una clave nueva por intento", async () => {
    await markMissingItemArrivedAction(PREV, formData("mi-1"));
    await markMissingItemArrivedAction(PREV, formData("mi-1"));

    for (const call of mocks.enqueueArrival.mock.calls) {
      expect(call[0]).toBe("pending-1");
    }
    expect(mocks.enqueueArrival).toHaveBeenCalledTimes(2);
  });
});
