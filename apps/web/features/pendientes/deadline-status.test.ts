import { describe, expect, it } from "vitest";

import { computeDeadlineStatus } from "./deadline-status";

const now = new Date("2026-06-06T12:00:00");

describe("computeDeadlineStatus", () => {
  it("vencido: promesa pasada y status no final", () => {
    const promisedAt = new Date("2026-06-06T11:00:00"); // 1h en el pasado
    expect(computeDeadlineStatus(promisedAt, "PENDIENTE", now)).toBe("VENCIDO");
  });

  it("vence pronto: promesa dentro de las próximas 2 horas", () => {
    const promisedAt = new Date("2026-06-06T13:30:00"); // +1h30
    expect(computeDeadlineStatus(promisedAt, "PENDIENTE", now)).toBe(
      "VENCE_PRONTO",
    );
  });

  it("a tiempo: promesa futura fuera de la ventana crítica", () => {
    const promisedAt = new Date("2026-06-06T18:00:00"); // +6h
    expect(computeDeadlineStatus(promisedAt, "PARCIAL", now)).toBe("A_TIEMPO");
  });

  it("finalizado: status ENTREGADO o CANCELADO ignora la promesa", () => {
    const overdue = new Date("2026-06-06T08:00:00"); // vencida, pero...
    expect(computeDeadlineStatus(overdue, "ENTREGADO", now)).toBe("FINALIZADO");
    expect(computeDeadlineStatus(overdue, "CANCELADO", now)).toBe("FINALIZADO");
  });
});
