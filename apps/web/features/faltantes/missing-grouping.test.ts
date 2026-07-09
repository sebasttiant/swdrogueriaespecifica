import { describe, expect, it } from "vitest";

import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";
import { SOON_WINDOW_MS } from "../pendientes/deadline-status";

import { groupMissingItems } from "./missing-grouping";

const now = new Date("2026-06-06T12:00:00");

function item(overrides: Partial<MissingItemListItem>): MissingItemListItem {
  return {
    id: "missing-id",
    quantity: 1,
    status: "FALTANTE",
    originId: null,
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    createdAt: new Date("2026-06-01T00:00:00"),
    product: { id: "product-id", name: "Producto", code: "COD-1", unit: "unidad" },
    origin: null,
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
  it("agrupa como EN_CURSO un faltante manual (origin null)", () => {
    const manual = item({ id: "manual", origin: null, originId: null });

    const groups = groupMissingItems([manual], now);

    expect(groups).toEqual([{ key: "EN_CURSO", items: [manual] }]);
  });

  it("agrupa como VENCIDO cuando la promesa del origen ya pasó", () => {
    const overdue = item({
      id: "overdue",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date("2026-06-06T11:00:00") }), // -1h
    });

    const groups = groupMissingItems([overdue], now);

    expect(groups).toEqual([{ key: "VENCIDO", items: [overdue] }]);
  });

  it("agrupa como VENCE_PRONTO dentro de la ventana crítica de 2h", () => {
    const soon = item({
      id: "soon",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date("2026-06-06T13:30:00") }), // +1h30
    });

    const groups = groupMissingItems([soon], now);

    expect(groups).toEqual([{ key: "VENCE_PRONTO", items: [soon] }]);
  });

  it("agrupa como EN_CURSO un origen ENTREGADO/CANCELADO aunque la promesa esté vencida", () => {
    const delivered = item({
      id: "delivered",
      originId: "pending-id",
      origin: origin({
        promisedAt: new Date("2026-06-06T08:00:00"), // vencida, pero...
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

    const groups = groupMissingItems([delivered, cancelled], now);

    expect(groups).toEqual([
      { key: "EN_CURSO", items: [delivered, cancelled] },
    ]);
  });

  it("omite grupos vacíos y respeta el orden fijo VENCIDO -> VENCE_PRONTO -> EN_CURSO", () => {
    const enCurso = item({ id: "en-curso", origin: null });
    const venceProto = item({
      id: "vence-pronto",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date("2026-06-06T13:00:00") }), // +1h
    });
    const vencido = item({
      id: "vencido",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date("2026-06-06T10:00:00") }), // -2h
    });

    // Orden de entrada intencionalmente mezclado.
    const groups = groupMissingItems([enCurso, venceProto, vencido], now);

    expect(groups.map((group) => group.key)).toEqual([
      "VENCIDO",
      "VENCE_PRONTO",
      "EN_CURSO",
    ]);
  });

  it("preserva el orden dentro de cada grupo tal como llegó", () => {
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

    const groups = groupMissingItems([boundary], now);

    expect(groups).toEqual([{ key: "VENCE_PRONTO", items: [boundary] }]);
  });

  it("remainingMs === 1ms (un ms en el futuro) agrupa como VENCE_PRONTO", () => {
    const boundary = item({
      id: "boundary-plus-one",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date(now.getTime() + 1) }),
    });

    const groups = groupMissingItems([boundary], now);

    expect(groups).toEqual([{ key: "VENCE_PRONTO", items: [boundary] }]);
  });

  it("remainingMs === -1ms (un ms en el pasado) agrupa como VENCIDO", () => {
    const boundary = item({
      id: "boundary-minus-one",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date(now.getTime() - 1) }),
    });

    const groups = groupMissingItems([boundary], now);

    expect(groups).toEqual([{ key: "VENCIDO", items: [boundary] }]);
  });

  it("remainingMs === SOON_WINDOW_MS exacto agrupa como VENCE_PRONTO (límite inclusivo)", () => {
    const boundary = item({
      id: "boundary-window",
      originId: "pending-id",
      origin: origin({ promisedAt: new Date(now.getTime() + SOON_WINDOW_MS) }),
    });

    const groups = groupMissingItems([boundary], now);

    expect(groups).toEqual([{ key: "VENCE_PRONTO", items: [boundary] }]);
  });

  it("remainingMs === SOON_WINDOW_MS + 1ms agrupa como EN_CURSO (ruta A_TIEMPO)", () => {
    const boundary = item({
      id: "boundary-window-plus-one",
      originId: "pending-id",
      origin: origin({
        promisedAt: new Date(now.getTime() + SOON_WINDOW_MS + 1),
      }),
    });

    const groups = groupMissingItems([boundary], now);

    expect(groups).toEqual([{ key: "EN_CURSO", items: [boundary] }]);
  });

  it("un item A_TIEMPO con origin NO nulo agrupa como EN_CURSO (ruta A_TIEMPO real, no origin:null ni FINALIZADO)", () => {
    const onTime = item({
      id: "on-time-with-origin",
      originId: "pending-id",
      origin: origin({
        promisedAt: new Date(now.getTime() + SOON_WINDOW_MS + 60 * 60 * 1000), // +1h más allá de la ventana crítica
        status: "PENDIENTE",
      }),
    });

    const groups = groupMissingItems([onTime], now);

    expect(groups).toEqual([{ key: "EN_CURSO", items: [onTime] }]);
  });
});
