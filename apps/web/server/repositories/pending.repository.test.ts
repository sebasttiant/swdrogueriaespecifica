import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    pending: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { encodeCursor } from "@/lib/pagination";
import {
  cancelPending,
  countOverduePendings,
  countUpcomingPendings,
  listPendings,
  listUrgentPendings,
  lockPendingForUpdate,
  updatePendingAfterDelivery,
  updatePendingManagementStatus,
} from "./pending.repository";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.pending.findMany.mockResolvedValue([]);
  prismaMock.pending.count.mockResolvedValue(0);
});

// Cliente de transacción falso: lock y CAS solo corren dentro de una
// transacción interactiva, así que reciben `tx`, nunca el prisma default.
function txClient() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pending: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

// SQL emitido por el tagged template de `$queryRaw`.
function sqlFrom(call: readonly unknown[]): string {
  return (call[0] as readonly string[]).join("?");
}

// ---------------------------------------------------------------------------
// Concurrencia: lock de fila + compare-and-set. Es lo que impide que dos
// operadores sobre-entreguen o que una cancelación pise una entrega.
// ---------------------------------------------------------------------------

describe("lockPendingForUpdate", () => {
  it("emits SELECT ... FOR UPDATE on pendings with the id bound as a parameter", async () => {
    const tx = txClient();
    const row = { id: "pend-1", quantity: 10, deliveredQuantity: 0, status: "PENDIENTE" };
    tx.$queryRaw.mockResolvedValue([row]);

    await expect(lockPendingForUpdate(tx as never, "pend-1")).resolves.toEqual(row);

    const call = tx.$queryRaw.mock.calls[0]!;
    const sql = sqlFrom(call);
    // Una lectura plana dentro de la transacción NO bloquea bajo READ COMMITTED.
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("FROM pendings");
    // Trae los campos que las reglas de entrega necesitan.
    expect(sql).toContain('"deliveredQuantity"');
    // El id viaja como parámetro del template, nunca interpolado en el SQL.
    expect(call.slice(1)).toEqual(["pend-1"]);
    expect(sql).not.toContain("pend-1");
  });

  it("returns null when the row does not exist", async () => {
    const tx = txClient();

    await expect(lockPendingForUpdate(tx as never, "ghost")).resolves.toBeNull();
  });
});

describe("updatePendingAfterDelivery", () => {
  it("only writes when status and deliveredQuantity still match the locked read", async () => {
    const tx = txClient();
    const completedAt = new Date("2026-07-09T12:00:00.000Z");

    const written = await updatePendingAfterDelivery(tx as never, {
      id: "pend-1",
      expectedStatus: "PARCIAL",
      expectedDeliveredQuantity: 4,
      deliveredQuantity: 10,
      status: "ENTREGADO",
      completedAt,
    });

    expect(written).toBe(1);
    expect(tx.pending.updateMany).toHaveBeenCalledWith({
      where: { id: "pend-1", status: "PARCIAL", deliveredQuantity: 4 },
      data: { deliveredQuantity: 10, status: "ENTREGADO", completedAt },
    });
  });

  it("reports zero rows written when the compare-and-set misses", async () => {
    const tx = txClient();
    tx.pending.updateMany.mockResolvedValue({ count: 0 });

    const written = await updatePendingAfterDelivery(tx as never, {
      id: "pend-1",
      expectedStatus: "PENDIENTE",
      expectedDeliveredQuantity: 0,
      deliveredQuantity: 3,
      status: "PARCIAL",
      completedAt: null,
    });

    expect(written).toBe(0);
  });
});

describe("cancelPending", () => {
  it("only cancels when the status still matches the locked read", async () => {
    const tx = txClient();
    const cancelledAt = new Date("2026-07-09T12:00:00.000Z");

    const written = await cancelPending(tx as never, {
      id: "pend-1",
      expectedStatus: "PARCIAL",
      cancelledById: "sup-1",
      cancelledAt,
      cancelReason: "Cliente desistió",
    });

    expect(written).toBe(1);
    expect(tx.pending.updateMany).toHaveBeenCalledWith({
      where: { id: "pend-1", status: "PARCIAL" },
      data: {
        status: "CANCELADO",
        cancelledAt,
        cancelledById: "sup-1",
        cancelReason: "Cliente desistió",
      },
    });
  });

  it("normalizes a missing reason to null", async () => {
    const tx = txClient();

    await cancelPending(tx as never, {
      id: "pend-1",
      expectedStatus: "PENDIENTE",
      cancelledById: "sup-1",
      cancelledAt: new Date(),
    });

    const args = tx.pending.updateMany.mock.calls[0]![0];
    expect(args.data.cancelReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// countUpcomingPendings — 24h window, open statuses only
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-09T17:00:00.000Z");
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_24H = 24 * MS_PER_HOUR;

describe("countUpcomingPendings", () => {
  it("returns the count from Prisma", async () => {
    prismaMock.pending.count.mockResolvedValueOnce(5);

    const result = await countUpcomingPendings(NOW);

    expect(result).toBe(5);
    expect(prismaMock.pending.count).toHaveBeenCalledTimes(1);
  });

  it("query uses status IN OPEN_STATUSES (PENDIENTE, PARCIAL)", async () => {
    await countUpcomingPendings(NOW);

    const call = prismaMock.pending.count.mock.calls[0]![0];
    expect(call.where.status.in).toContain("PENDIENTE");
    expect(call.where.status.in).toContain("PARCIAL");
  });

  it("query: promisedAt >= now (lower bound inclusive)", async () => {
    await countUpcomingPendings(NOW);

    const call = prismaMock.pending.count.mock.calls[0]![0];
    expect(call.where.promisedAt.gte).toBeInstanceOf(Date);
    // gte should equal or be very close to NOW
    expect(Math.abs(call.where.promisedAt.gte.getTime() - NOW.getTime())).toBeLessThan(
      1000,
    );
  });

  it("query: promisedAt <= now + 24h (upper bound inclusive — exactly now+24h should count)", async () => {
    await countUpcomingPendings(NOW);

    const call = prismaMock.pending.count.mock.calls[0]![0];
    expect(call.where.promisedAt.lte).toBeInstanceOf(Date);
    // lte should be NOW + 24h
    expect(
      Math.abs(call.where.promisedAt.lte.getTime() - (NOW.getTime() + MS_24H)),
    ).toBeLessThan(1000);
  });

  it("closed status (ENTREGADO) not included: only open statuses", async () => {
    await countUpcomingPendings(NOW);

    const call = prismaMock.pending.count.mock.calls[0]![0];
    expect(call.where.status.in).not.toContain("ENTREGADO");
  });

  it("works without a now argument", async () => {
    await expect(countUpcomingPendings()).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// El cursor es input controlado por el usuario (?cursor=...): nunca debe
// romper la consulta ni filtrarse a Prisma si apunta a un id inexistente.
// ---------------------------------------------------------------------------

describe("listPendings · scope", () => {
  // La vista operativa por defecto muestra lo que todavía requiere atención. Un
  // ENTREGADO/CANCELADO ya no se trabaja: si entra en el listado por defecto,
  // llena la primera página y empuja los abiertos detrás de la paginación.
  it("filtra a estados abiertos por defecto (sin scope)", async () => {
    await listPendings({});

    const args = prismaMock.pending.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      status: {
        in: ["PENDIENTE", "PARCIAL", "SOLICITADO", "BUSQUEDA", "COTIZANDO", "AGOTADO"],
      },
    });
  });

  it("filtra a estados abiertos con scope active explícito", async () => {
    await listPendings({ scope: "active" });

    const args = prismaMock.pending.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      status: {
        in: ["PENDIENTE", "PARCIAL", "SOLICITADO", "BUSQUEDA", "COTIZANDO", "AGOTADO"],
      },
    });
  });

  // El historial es una vista aparte, no la operativa: ahí sí entran los cerrados.
  it("no filtra por estado con scope history", async () => {
    await listPendings({ scope: "history" });

    const args = prismaMock.pending.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });
});

describe("listPendings · seguridad del cursor", () => {
  it("ignora un cursor malformado y sirve la primera página", async () => {
    await listPendings({ cursor: "###no-es-base64###" });

    // decodeCursor descarta la basura antes de llegar a la base.
    expect(prismaMock.pending.findUnique).not.toHaveBeenCalled();
    const args = prismaMock.pending.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("ignora un cursor bien formado pero inexistente (primera página)", async () => {
    prismaMock.pending.findUnique.mockResolvedValue(null);

    await listPendings({ cursor: encodeCursor("fantasma-9999") });

    expect(prismaMock.pending.findUnique).toHaveBeenCalledWith({
      where: { id: "fantasma-9999" },
      select: { id: true },
    });
    const args = prismaMock.pending.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("pagina normalmente con un cursor válido y existente", async () => {
    prismaMock.pending.findUnique.mockResolvedValue({ id: "real-id" });

    await listPendings({ cursor: encodeCursor("real-id") });

    const args = prismaMock.pending.findMany.mock.calls[0]![0];
    expect(args.cursor).toEqual({ id: "real-id" });
    expect(args.skip).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Estados de gestión (Mejora 2) en las ALERTAS: los estados en curso
// (SOLICITADO/BUSQUEDA/COTIZANDO) siguen alertables; AGOTADO queda EXCLUIDO
// porque ya no tiene acción de gestión pendiente.
// ---------------------------------------------------------------------------

describe("alertas · estados de gestión", () => {
  it("countOverduePendings incluye los estados en curso pero excluye AGOTADO", async () => {
    await countOverduePendings(NOW);

    const call = prismaMock.pending.count.mock.calls[0]![0];
    expect(call.where.status.in).toEqual(
      expect.arrayContaining(["SOLICITADO", "BUSQUEDA", "COTIZANDO"]),
    );
    expect(call.where.status.in).not.toContain("AGOTADO");
  });

  it("countUpcomingPendings excluye AGOTADO de la ventana de 24h", async () => {
    await countUpcomingPendings(NOW);

    const call = prismaMock.pending.count.mock.calls[0]![0];
    expect(call.where.status.in).not.toContain("AGOTADO");
  });

  it("listUrgentPendings excluye AGOTADO del listado de urgentes", async () => {
    await listUrgentPendings(5);

    const args = prismaMock.pending.findMany.mock.calls[0]![0];
    expect(args.where.status.in).not.toContain("AGOTADO");
    expect(args.where.status.in).toEqual(
      expect.arrayContaining(["PENDIENTE", "PARCIAL", "SOLICITADO"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Compare-and-set del estado de gestión: solo escribe si el pendiente sigue en
// un estado elegible, para no pisar una entrega/cancelación concurrente.
// ---------------------------------------------------------------------------

describe("updatePendingManagementStatus", () => {
  it("emite un updateMany guardado por los estados elegibles y devuelve las filas escritas", async () => {
    prismaMock.pending.updateMany.mockResolvedValueOnce({ count: 1 });

    const written = await updatePendingManagementStatus({
      id: "pend-1",
      status: "SOLICITADO",
      eligibleStatuses: ["PENDIENTE", "COTIZANDO"],
    });

    expect(written).toBe(1);
    expect(prismaMock.pending.updateMany).toHaveBeenCalledWith({
      where: { id: "pend-1", status: { in: ["PENDIENTE", "COTIZANDO"] } },
      data: { status: "SOLICITADO" },
    });
  });

  it("uses expectedStatus=PENDIENTE as the exact Prisma CAS predicate", async () => {
    prismaMock.pending.updateMany.mockResolvedValueOnce({ count: 1 });

    await updatePendingManagementStatus({
      id: "pend-1",
      status: "SOLICITADO",
      eligibleStatuses: ["PENDIENTE", "SOLICITADO"],
      expectedStatus: "PENDIENTE",
    });

    expect(prismaMock.pending.updateMany).toHaveBeenCalledWith({
      where: { id: "pend-1", status: "PENDIENTE" },
      data: { status: "SOLICITADO" },
    });
  });

  it("devuelve 0 cuando ningún pendiente elegible coincide (inexistente o ya cerrado)", async () => {
    prismaMock.pending.updateMany.mockResolvedValueOnce({ count: 0 });

    const written = await updatePendingManagementStatus({
      id: "pend-terminal",
      status: "AGOTADO",
      eligibleStatuses: ["PENDIENTE"],
    });

    expect(written).toBe(0);
  });
});
