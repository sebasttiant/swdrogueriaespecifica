import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    missingItem: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      // Referencias de campo de Prisma: la cola activa compara `receivedQuantity`
      // contra `orderedQuantity` COLUMNA a COLUMNA, y para eso el repositorio le
      // pide al cliente la referencia. Acá alcanza un centinela: lo que se
      // verifica es que la consulta la incluya, no cómo la serializa Prisma.
      fields: { orderedQuantity: "__ref:orderedQuantity" },
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { encodeCursor } from "@/lib/pagination";
import {
  confirmMissingItem,
  countConfirmedMissingItems,
  countOrderedMissingItems,
  countOverdueMissingItems,
  countUnclosedActionableMissingItemsBefore,
  createMissingItem,
  listMissingItems,
  lockMissingItemForUpdate,
  orderMissingItem,
} from "./missing-item.repository";

// Cliente de transacción falso: las funciones de lock/CAS solo corren dentro de
// una transacción interactiva, así que reciben `tx`, nunca el prisma default.
function txClient() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    missingItem: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

// SQL emitido por el tagged template de `$queryRaw`.
function sqlFrom(call: readonly unknown[]): string {
  return (call[0] as readonly string[]).join("?");
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.missingItem.findMany.mockResolvedValue([]);
  prismaMock.missingItem.count.mockResolvedValue(0);
});

describe("listMissingItems · active confirmation filter", () => {
  // La cola operativa muestra SOLO lo que todavía requiere que gerencia haga
  // algo. Un PEDIDO ya fue comprado: sigue abierto (se cierra cuando llega el
  // stock) pero no requiere acción, así que sale de la cola.
  //
  // Regla de negocio confirmada por el gerente (reunión 2026-07-30):
  // "Cuando ellos le pongan el okay, que desaparezca de la lista."
  it("lists only items that still need action by default", async () => {
    await listMissingItems({});

    const where = prismaMock.missingItem.findMany.mock.calls[0]![0].where;
    expect(where.AND[0]).toEqual({
      confirmedAt: null,
      status: { in: ["FALTANTE"] },
    });
    // Los datos inválidos tampoco requieren acción: nadie puede "pedir" un
    // faltante que ya recibió más de lo esperado. Salen por cuarentena (D10).
    expect(where.AND[1]).toEqual({
      NOT: { receivedQuantity: { gt: "__ref:orderedQuantity" } },
    });
  });

  // REGRESIÓN CRÍTICA: sacar PEDIDO de la cola NO puede sacarlo del eje
  // "sigue abierto". Si se colara en el filtro del cierre FIFO, los faltantes
  // ya pedidos nunca se cerrarían solos al entrar el stock.
  it("does not remove PEDIDO from the still-open axis used elsewhere", async () => {
    await countOverdueMissingItems(new Date("2026-07-30T12:00:00.000Z"));

    expect(prismaMock.missingItem.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["FALTANTE", "PEDIDO"] },
        }),
      }),
    );
  });

  it("keeps confirmed rows queryable when history is requested", async () => {
    await listMissingItems({ scope: "history" });

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.where).toBeUndefined();
  });

  // "Ya pedidos" es la cola ACTIVA: se pidió y todavía no llegó todo. Incluye
  // los pedidos históricos (`FALTANTE` + `confirmedAt`), que son órdenes reales
  // anteriores al flujo actual; sin esa rama no aparecerían en NINGUNA vista.
  //
  // RECIBIDO ya NO entra (D10): completado es historial. Mezclarlo hacía que la
  // pantalla creciera para siempre y que "¿qué estoy esperando?" no tuviera
  // respuesta.
  it("lists ordered items, including legacy confirmed rows", async () => {
    await listMissingItems({ scope: "ordered" });

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.where.AND[0]).toEqual({
      OR: [
        { status: "PEDIDO" },
        { status: "FALTANTE", confirmedAt: { not: null } },
      ],
    });
    // Le falta mercadería. `orderedQuantity` nula = sin derivar todavía, así
    // que sigue faltando: una fila vieja no se esconde por un dato que nunca
    // se le pidió cargar.
    expect(args.where.AND[1]).toEqual({
      OR: [
        { orderedQuantity: null },
        { receivedQuantity: { lt: "__ref:orderedQuantity" } },
      ],
    });
    expect(args.where.AND[2]).toEqual({
      NOT: { receivedQuantity: { gt: "__ref:orderedQuantity" } },
    });
  });

  it("does not list RECIBIDO in the active queue: completed is history", async () => {
    await listMissingItems({ scope: "ordered" });

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(JSON.stringify(args.where)).not.toContain("RECIBIDO");
  });

  it("lists quarantined rows on their own scope", async () => {
    await listMissingItems({ scope: "quarantine" });

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      receivedQuantity: { gt: "__ref:orderedQuantity" },
    });
  });

  it("lists discarded items on their own scope", async () => {
    await listMissingItems({ scope: "discarded" });

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ status: "CANCELADO" });
  });

  // La cantidad pedida se muestra en la vista de Pedidos; el listado tiene que
  // traerla. Es distinta de `quantity` (necesidad), así que se selecciona aparte.
  it("selects orderedQuantity so the ordered amount can be shown", async () => {
    await listMissingItems({});

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.select.orderedQuantity).toBe(true);
  });

  it("selects the authorizing user relation, limited to id and name", async () => {
    await listMissingItems({});

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.select.confirmedBy).toEqual({ select: { id: true, name: true } });
  });

  // Atribución operativa. Respaldo del gerente (reunión 2026-07-30, min 2:52):
  // "Espérate, ¿quién colocó esto? ... Ah, eso lo colocó Andrés."
  // Son dos personas trabajando la misma cola y hoy no se distingue quién tocó
  // qué. Mismo criterio de minimización que `confirmedBy`: SOLO id y nombre,
  // nunca email, rol ni credenciales.
  it("selects who ordered and who discarded, limited to id and name", async () => {
    await listMissingItems({});

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.select.orderedBy).toEqual({ select: { id: true, name: true } });
    expect(args.select.discardedBy).toEqual({ select: { id: true, name: true } });
  });

  it("selects discardedAt so the discard can be dated in its view", async () => {
    await listMissingItems({});

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.select.discardedAt).toBe(true);
  });
});

describe("lockMissingItemForUpdate", () => {
  it("emits SELECT ... FOR UPDATE on missing_items with the id bound as a parameter", async () => {
    const tx = txClient();
    tx.$queryRaw.mockResolvedValue([{ id: "missing-1", status: "FALTANTE" }]);

    const row = await lockMissingItemForUpdate(tx as never, "missing-1");

    const call = tx.$queryRaw.mock.calls[0]!;
    const sql = sqlFrom(call);
    // `FOR UPDATE` es la garantía real de serialización. Sin él, dos gerentes
    // leen `FALTANTE` a la vez y el último pedido pisa al primero.
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("FROM missing_items");
    // El id viaja como parámetro del template, nunca interpolado en el SQL.
    expect(call.slice(1)).toEqual(["missing-1"]);
    expect(sql).not.toContain("missing-1");
    expect(row).toEqual({ id: "missing-1", status: "FALTANTE" });
  });

  it("returns null when the row does not exist", async () => {
    const tx = txClient();

    await expect(lockMissingItemForUpdate(tx as never, "ghost")).resolves.toBeNull();
  });
});

describe("orderMissingItem", () => {
  // Pedido rápido ("chulito"): gerencia registra que YA compró, sin frenarse a
  // elegir proveedor ni cantidad. Ambos quedan null y se completan después con
  // el formulario largo. La base ya los acepta nulos (`supplierId String?`,
  // `orderedQuantity Int?` con CHECK "IS NULL OR > 0"): sin migración.
  it("writes a quick order with no supplier and no quantity", async () => {
    const tx = txClient();
    const orderedAt = new Date("2026-07-30T12:00:00.000Z");

    const written = await orderMissingItem(tx as never, "missing-1", {
      orderedById: "admin-1",
      orderedAt,
    });

    expect(written).toBe(1);
    expect(tx.missingItem.updateMany).toHaveBeenCalledWith({
      // El compare-and-set es EL MISMO que el del pedido completo: pedir rápido
      // no afloja la protección contra la escritura concurrente.
      where: { id: "missing-1", status: "FALTANTE", confirmedAt: null },
      data: {
        status: "PEDIDO",
        orderedAt,
        orderedById: "admin-1",
        supplierId: null,
        orderedQuantity: null,
      },
    });
  });

  it("only writes when the row is still FALTANTE and unconfirmed, returning the row count", async () => {
    const tx = txClient();
    const orderedAt = new Date("2026-07-09T12:00:00.000Z");

    const written = await orderMissingItem(tx as never, "missing-1", {
      supplierId: "sup-1",
      orderedById: "admin-1",
      orderedAt,
      orderedQuantity: 20,
    });

    expect(written).toBe(1);
    // El `where` es el compare-and-set: un faltante ya PEDIDO o ya confirmado
    // no coincide, así que la escritura no aplica en vez de pisar el estado.
    // `orderedQuantity` se persiste en el MISMO update atómico que el status.
    expect(tx.missingItem.updateMany).toHaveBeenCalledWith({
      where: { id: "missing-1", status: "FALTANTE", confirmedAt: null },
      data: {
        status: "PEDIDO",
        orderedAt,
        orderedById: "admin-1",
        supplierId: "sup-1",
        orderedQuantity: 20,
      },
    });
  });

  it("reports zero rows written when the compare-and-set misses", async () => {
    const tx = txClient();
    tx.missingItem.updateMany.mockResolvedValue({ count: 0 });

    const written = await orderMissingItem(tx as never, "missing-1", {
      supplierId: "sup-1",
      orderedById: "admin-1",
      orderedAt: new Date(),
      orderedQuantity: 20,
    });

    expect(written).toBe(0);
  });
});

describe("confirmMissingItem", () => {
  it("stores confirmation metadata guarded by status FALTANTE + confirmedAt: null, without deleting the row", async () => {
    const tx = txClient();
    const confirmedAt = new Date("2026-07-02T20:00:00.000Z");

    const written = await confirmMissingItem(tx as never, {
      id: "missing-1",
      confirmedById: "admin-1",
      confirmedAt,
      note: "Gestión OK",
    });

    expect(written).toBe(1);
    expect(tx.missingItem.updateMany).toHaveBeenCalledWith({
      // El CAS refuerza la invariante del service: confirmar dos veces, o
      // confirmar sobre un faltante que un pedido concurrente pasó a PEDIDO,
      // no coincide y no reescribe la confirmación (evita PEDIDO + confirmedAt).
      where: { id: "missing-1", status: "FALTANTE", confirmedAt: null },
      data: {
        confirmedAt,
        confirmedById: "admin-1",
        confirmationNote: "Gestión OK",
      },
    });
  });

  it("normalizes a missing note to null", async () => {
    const tx = txClient();

    await confirmMissingItem(tx as never, {
      id: "missing-1",
      confirmedById: "admin-1",
      confirmedAt: new Date(),
    });

    const args = tx.missingItem.updateMany.mock.calls[0]![0];
    expect(args.data.confirmationNote).toBeNull();
  });
});

// El cursor es input controlado por el usuario (?cursor=...): nunca debe
// romper la consulta ni filtrarse a Prisma si apunta a un id inexistente.
describe("listMissingItems · seguridad del cursor", () => {
  it("ignora un cursor malformado y sirve la primera página", async () => {
    await listMissingItems({ cursor: "###no-es-base64###" });

    // decodeCursor descarta la basura antes de llegar a la base.
    expect(prismaMock.missingItem.findUnique).not.toHaveBeenCalled();
    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("ignora un cursor bien formado pero inexistente (primera página)", async () => {
    prismaMock.missingItem.findUnique.mockResolvedValue(null);

    await listMissingItems({ cursor: encodeCursor("fantasma-9999") });

    expect(prismaMock.missingItem.findUnique).toHaveBeenCalledWith({
      where: { id: "fantasma-9999" },
      select: { id: true },
    });
    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("pagina normalmente con un cursor válido y existente", async () => {
    prismaMock.missingItem.findUnique.mockResolvedValue({ id: "real-id" });

    await listMissingItems({ cursor: encodeCursor("real-id") });

    const args = prismaMock.missingItem.findMany.mock.calls[0]![0];
    expect(args.cursor).toEqual({ id: "real-id" });
    expect(args.skip).toBe(1);
  });
});

describe("listMissingItems · origen del pendiente", () => {
  it("devuelve el origen cuando el faltante está enlazado a un pendiente", async () => {
    const promisedAt = new Date("2026-06-09T15:00:00.000Z");
    prismaMock.missingItem.findMany.mockResolvedValue([
      {
        id: "missing-1",
        quantity: 2,
        status: "FALTANTE",
        originId: "pending-1",
        createdAt: new Date("2026-06-09T12:00:00.000Z"),
        product: {
          id: "product-1",
          name: "Vitamina C",
          code: "VIT-C",
          unit: "caja",
        },
        origin: {
          id: "pending-1",
          promisedAt,
          status: "PENDIENTE",
          customerName: "Cliente Uno",
        },
      },
    ]);

    const result = await listMissingItems({});

    expect(result.items).toEqual([
      expect.objectContaining({
        id: "missing-1",
        origin: {
          id: "pending-1",
          promisedAt,
          status: "PENDIENTE",
          customerName: "Cliente Uno",
        },
      }),
    ]);
    expect(prismaMock.missingItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          origin: {
            select: {
              id: true,
              promisedAt: true,
              status: true,
              customerName: true,
            },
          },
        }),
      }),
    );
  });

  it("devuelve origin null cuando el faltante no viene de un pendiente", async () => {
    prismaMock.missingItem.findMany.mockResolvedValue([
      {
        id: "missing-manual",
        quantity: 1,
        status: "PEDIDO",
        originId: null,
        createdAt: new Date("2026-06-09T12:00:00.000Z"),
        product: {
          id: "product-2",
          name: "Alcohol",
          code: "ALC",
          unit: "unidad",
        },
        origin: null,
      },
    ]);

    const result = await listMissingItems({});

    expect(result.items).toEqual([
      expect.objectContaining({ id: "missing-manual", origin: null }),
    ]);
  });
});

describe("countOverdueMissingItems", () => {
  it("cuenta faltantes abiertos con origen vencido", async () => {
    const now = new Date("2026-06-09T15:00:00.000Z");
    prismaMock.missingItem.count.mockResolvedValue(3);

    const result = await countOverdueMissingItems(now);

    expect(result).toBe(3);
    expect(prismaMock.missingItem.count).toHaveBeenCalledWith({
      where: {
        status: { in: ["FALTANTE", "PEDIDO"] },
        confirmedAt: null,
        originId: { not: null },
        origin: { promisedAt: { lt: now } },
      },
    });
  });

  it("excluye faltantes sin origen y estados cerrados desde el filtro", async () => {
    const now = new Date("2026-06-09T15:00:00.000Z");

    await countOverdueMissingItems(now);

    const where = prismaMock.missingItem.count.mock.calls[0]![0].where;
    expect(where.originId).toEqual({ not: null });
    expect(where.status.in).toEqual(["FALTANTE", "PEDIDO"]);
    expect(where.status.in).not.toContain("RECIBIDO");
    expect(where.status.in).not.toContain("CANCELADO");
  });
});

// Los chips de la cola operativa cuentan el estado GLOBAL, no el de la página
// paginada: mezclar ambas escalas en una misma franja daría números que no
// comparan entre sí.
describe("countOrderedMissingItems", () => {
  it("cuenta los faltantes en estado PEDIDO", async () => {
    prismaMock.missingItem.count.mockResolvedValue(3);

    await expect(countOrderedMissingItems()).resolves.toBe(3);
    expect(prismaMock.missingItem.count).toHaveBeenCalledWith({
      where: { status: "PEDIDO" },
    });
  });
});

describe("countConfirmedMissingItems", () => {
  // "OK gerencia" es la confirmación, y el service garantiza que un PEDIDO nunca
  // queda confirmado. Se cuenta por `confirmedAt`, que es el hecho registrado.
  it("cuenta los faltantes con OK gerencia por su fecha de confirmación", async () => {
    prismaMock.missingItem.count.mockResolvedValue(7);

    await expect(countConfirmedMissingItems()).resolves.toBe(7);
    expect(prismaMock.missingItem.count).toHaveBeenCalledWith({
      where: { confirmedAt: { not: null } },
    });
  });
});

// La alerta de gerencia debe mostrar solo lo que requiere trabajo de gestión.
// Regla reunión 2026-08-14: al marcar "ya lo pedí" el faltante sale de la
// alerta. Por eso el conteo usa ACTIONABLE_STATUSES (solo FALTANTE) y NO
// OPEN_STATUSES (que incluye PEDIDO).
describe("countUnclosedActionableMissingItemsBefore", () => {
  const threshold = new Date("2026-08-14T10:00:00.000Z");

  it("cuenta solo faltantes accionables anteriores al umbral", async () => {
    prismaMock.missingItem.count.mockResolvedValue(5);

    const result = await countUnclosedActionableMissingItemsBefore(threshold);

    expect(result).toBe(5);
    expect(prismaMock.missingItem.count).toHaveBeenCalledWith({
      where: {
        confirmedAt: null,
        status: { in: ["FALTANTE"] },
        createdAt: { lt: threshold },
      },
    });
  });

  it("excluye los ya pedidos (PEDIDO) para no inflar la alerta", async () => {
    await countUnclosedActionableMissingItemsBefore(threshold);

    const where = prismaMock.missingItem.count.mock.calls[0]![0].where;
    expect(where.status.in).toEqual(["FALTANTE"]);
    expect(where.status.in).not.toContain("PEDIDO");
    expect(where.status.in).not.toContain("EN_BODEGA");
    expect(where.status.in).not.toContain("RECIBIDO");
    expect(where.status.in).not.toContain("CANCELADO");
  });
});

describe("createMissingItem", () => {
  it("creates a manual missing item with originId null, note, and seller code", async () => {
    prismaMock.missingItem.create.mockResolvedValue({ id: "missing-manual" });

    await expect(
      createMissingItem({
        productId: "prod-1",
        quantity: 4,
        originId: null,
        createdById: "admin-1",
        note: "Prioridad mostrador",
        sellerCode: "VEN-12",
      }),
    ).resolves.toEqual({ id: "missing-manual" });

    expect(prismaMock.missingItem.create).toHaveBeenCalledWith({
      data: {
        productId: "prod-1",
        quantity: 4,
        originId: null,
        createdById: "admin-1",
        note: "Prioridad mostrador",
        sellerCode: "VEN-12",
      },
    });
  });

  it("normalizes an omitted manual note to null without repurposing confirmationNote", async () => {
    prismaMock.missingItem.create.mockResolvedValue({ id: "missing-manual" });

    await createMissingItem({ productId: "prod-1", quantity: 1, originId: null });

    const args = prismaMock.missingItem.create.mock.calls[0]![0];
    expect(args.data.note).toBeNull();
    expect(args.data.sellerCode).toBeNull();
    expect(args.data.confirmationNote).toBeUndefined();
  });
});
