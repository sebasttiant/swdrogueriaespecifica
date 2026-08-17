import { describe, expect, it } from "vitest";

import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";
import { SOON_WINDOW_MS } from "../pendientes/deadline-status";

import { groupMissingItems } from "./missing-grouping";

const now = new Date("2026-06-06T12:00:00");

function item(overrides: Partial<MissingItemListItem>): MissingItemListItem {
  return {
    id: "missing-id",
    quantity: 1,
    orderedQuantity: null,
    receivedQuantity: 0,
    note: null,
    status: "FALTANTE",
    originId: null,
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    orderedAt: null,
    orderedById: null,
    orderedBy: null,
    discardedAt: null,
    discardedById: null,
    discardedBy: null,
    supplierId: null,
    sellerCode: null,
    createdAt: new Date("2026-06-01T00:00:00"),
    product: {
      id: "product-id",
      name: "Producto",
      code: "COD-1",
      unit: "unidad",
      laboratory: null,
    },
    origin: null,
    supplier: null,
    confirmedBy: null,
    createdBy: null,
    ...overrides,
  };
}

function origin(
  overrides: Partial<NonNullable<MissingItemListItem["origin"]>>,
): NonNullable<MissingItemListItem["origin"]> {
  return {
    id: "pending-id",
    promisedAt: new Date("2026-06-06T18:00:00"),
    status: "PENDIENTE",
    customerName: "Cliente",
    ...overrides,
  };
}

describe("groupMissingItems", () => {
  it("agrupa como EN_CURSO un faltante manual", () => {
    const manual = item({ id: "manual", origin: null, originId: null });

    expect(groupMissingItems([manual], now)).toEqual([
      { key: "EN_CURSO", items: [manual] },
    ]);
  });

  it("agrupa como EN_CURSO un origen ENTREGADO/CANCELADO aunque la promesa esté vencida", () => {
    const delivered = item({
      id: "delivered",
      originId: "pending-id",
      origin: origin({
        promisedAt: new Date("2026-06-06T08:00:00"),
        status: "ENTREGADO",
      }),
    });
    const cancelled = item({
      id: "cancelled",
      originId: "pending-id",
      origin: origin({
        promisedAt: new Date("2026-06-06T08:00:00"),
        status: "CANCELADO",
      }),
    });

    expect(groupMissingItems([delivered, cancelled], now)).toEqual([
      { key: "EN_CURSO", items: [delivered, cancelled] },
    ]);
  });

  it("agrupa por urgencia operativa", () => {
    const onTime = item({
      id: "en-curso",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date(now.getTime() + SOON_WINDOW_MS + 1) }),
    });
    const soon = item({
      id: "vence-pronto",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date("2026-06-06T13:30:00") }),
    });
    const overdue = item({
      id: "vencido",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date("2026-06-06T11:00:00") }),
    });

    const groups = groupMissingItems([onTime, soon, overdue], now);

    expect(groups).toEqual([
      { key: "VENCIDO", items: [overdue] },
      { key: "VENCE_PRONTO", items: [soon] },
      { key: "EN_CURSO", items: [onTime] },
    ]);
  });

  it("preserva el orden relativo dentro de la misma urgencia", () => {
    const first = item({
      id: "first",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date("2026-06-06T10:00:00") }),
    });
    const second = item({
      id: "second",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date("2026-06-06T09:00:00") }),
    });

    const groups = groupMissingItems([first, second], now);

    expect(groups).toEqual([{ key: "VENCIDO", items: [first, second] }]);
  });

  it("retorna arreglo vacío cuando no hay items", () => {
    expect(groupMissingItems([], now)).toEqual([]);
  });
});

describe("groupMissingItems — límites exactos de computeDeadlineStatus", () => {
  it("remainingMs === 0 (promisedAt === now) agrupa como VENCE_PRONTO, no VENCIDO", () => {
    const boundary = item({
      id: "boundary-zero",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date(now.getTime()) }),
    });

    expect(groupMissingItems([boundary], now)).toEqual([
      { key: "VENCE_PRONTO", items: [boundary] },
    ]);
  });

  it("remainingMs === 1ms (un ms en el futuro) agrupa como VENCE_PRONTO", () => {
    const boundary = item({
      id: "boundary-plus-one",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date(now.getTime() + 1) }),
    });

    expect(groupMissingItems([boundary], now)).toEqual([
      { key: "VENCE_PRONTO", items: [boundary] },
    ]);
  });

  it("remainingMs === -1ms (un ms en el pasado) agrupa como VENCIDO", () => {
    const boundary = item({
      id: "boundary-minus-one",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date(now.getTime() - 1) }),
    });

    expect(groupMissingItems([boundary], now)).toEqual([
      { key: "VENCIDO", items: [boundary] },
    ]);
  });

  it("remainingMs === SOON_WINDOW_MS exacto agrupa como VENCE_PRONTO (límite inclusivo)", () => {
    const boundary = item({
      id: "boundary-window",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date(now.getTime() + SOON_WINDOW_MS) }),
    });

    expect(groupMissingItems([boundary], now)).toEqual([
      { key: "VENCE_PRONTO", items: [boundary] },
    ]);
  });

  it("remainingMs === SOON_WINDOW_MS + 1ms agrupa como EN_CURSO (ruta A_TIEMPO)", () => {
    const boundary = item({
      id: "boundary-window-plus-one",
      originId: "pending-id",
      origin: origin({
        promisedAt: new Date(now.getTime() + SOON_WINDOW_MS + 1),
      }),
    });

    expect(groupMissingItems([boundary], now)).toEqual([
      { key: "EN_CURSO", items: [boundary] },
    ]);
  });

  it("un item A_TIEMPO con origin NO nulo agrupa como EN_CURSO", () => {
    const onTime = item({
      id: "on-time-with-origin",
      originId: "pending-id",
      origin: origin({
        promisedAt: new Date(now.getTime() + SOON_WINDOW_MS + 60 * 60 * 1000),
        status: "PENDIENTE",
      }),
    });

    expect(groupMissingItems([onTime], now)).toEqual([
      { key: "EN_CURSO", items: [onTime] },
    ]);
  });
});
