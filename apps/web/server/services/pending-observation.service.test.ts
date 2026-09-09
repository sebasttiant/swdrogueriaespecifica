import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/repositories/pending.repository", () => ({
  findPendingObservation: vi.fn(),
  setPendingManagementObservation: vi.fn(),
  // El módulo del servicio importa media docena de funciones más al cargarse;
  // sin estos stubs la importación falla antes de llegar a la que se prueba.
  cancelPending: vi.fn(),
  countOpenPendings: vi.fn(),
  countOverduePendings: vi.fn(),
  countUpcomingPendings: vi.fn(),
  countAllPendings: vi.fn(),
  createPending: vi.fn(),
  createPendingDelivery: vi.fn(),
  decodeQueueCursor: vi.fn(),
  deadlineWhere: vi.fn(),
  findPendingByIdempotencyKey: vi.fn(),
  findPendingInView: vi.fn(),
  groupPendingsByStatusSince: vi.fn(),
  listPendingCreatedAtSince: vi.fn(),
  listPendingIdentityQueue: vi.fn(),
  listPendings: vi.fn(),
  listUrgentPendings: vi.fn(),
  listUsedZones: vi.fn(),
  lockPendingForEdit: vi.fn(),
  lockPendingForUpdate: vi.fn(),
  openPendingWhere: vi.fn(),
  alertablePendingWhere: vi.fn(),
  updatePendingAfterDelivery: vi.fn(),
  updatePendingDetails: vi.fn(),
  updatePendingManagementStatus: vi.fn(),
}));

import {
  findPendingObservation,
  setPendingManagementObservation,
} from "@/server/repositories/pending.repository";
import { setPendingObservation } from "./pending.service";

const ACTOR = "user-gerencia";
const NOW = new Date("2026-09-09T15:00:00.000Z");

function currentIs(observation: string | null, version: number) {
  vi.mocked(findPendingObservation).mockResolvedValue({
    id: "pend-1",
    managementObservation: observation,
    managementObservationVersion: version,
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(setPendingManagementObservation).mockResolvedValue(1);
});

describe("setPendingObservation", () => {
  it("escribe la observación y sube la versión", async () => {
    currentIs(null, 0);
    const result = await setPendingObservation(
      { id: "pend-1", observation: "Llega el lunes", expectedVersion: 0, actorId: ACTOR },
      NOW,
    );
    expect(result).toEqual({ rejection: null, changed: true, version: 1 });
    expect(setPendingManagementObservation).toHaveBeenCalledWith({
      id: "pend-1",
      observation: "Llega el lunes",
      expectedVersion: 0,
      authorId: ACTOR,
      at: NOW,
    });
  });

  it("guardar el MISMO texto no escribe ni sube la versión", async () => {
    currentIs("Llega el lunes", 4);
    const result = await setPendingObservation(
      // Mismos caracteres, distinto espaciado: el teclado del celular no crea
      // una novedad.
      { id: "pend-1", observation: "  Llega   el lunes  ", expectedVersion: 4, actorId: ACTOR },
      NOW,
    );
    expect(result).toEqual({ rejection: null, changed: false, version: 4 });
    expect(setPendingManagementObservation).not.toHaveBeenCalled();
  });

  it("rechaza cuando otro gerente escribió mientras esta pantalla miraba", async () => {
    currentIs("Lo escribió el otro", 5);
    const result = await setPendingObservation(
      { id: "pend-1", observation: "Lo mío", expectedVersion: 4, actorId: ACTOR },
      NOW,
    );
    expect(result).toEqual({ rejection: "STALE", changed: false, version: 5 });
    expect(setPendingManagementObservation).not.toHaveBeenCalled();
  });

  it("rechaza cuando la carrera ocurre ENTRE la lectura y el UPDATE", async () => {
    currentIs("Llega el lunes", 4);
    vi.mocked(setPendingManagementObservation).mockResolvedValue(0);
    const result = await setPendingObservation(
      { id: "pend-1", observation: "Llega el martes", expectedVersion: 4, actorId: ACTOR },
      NOW,
    );
    expect(result.rejection).toBe("STALE");
    expect(result.changed).toBe(false);
  });

  it("vaciar es borrar: escribe null y sube la versión igual", async () => {
    currentIs("Llega el lunes", 2);
    const result = await setPendingObservation(
      { id: "pend-1", observation: "   ", expectedVersion: 2, actorId: ACTOR },
      NOW,
    );
    expect(result).toEqual({ rejection: null, changed: true, version: 3 });
    expect(setPendingManagementObservation).toHaveBeenCalledWith(
      expect.objectContaining({ observation: null }),
    );
  });

  it("vaciar una observación que ya estaba vacía no escribe nada", async () => {
    currentIs(null, 0);
    const result = await setPendingObservation(
      { id: "pend-1", observation: "", expectedVersion: 0, actorId: ACTOR },
      NOW,
    );
    expect(result.changed).toBe(false);
    expect(setPendingManagementObservation).not.toHaveBeenCalled();
  });

  it("rechaza un texto que no entra, sin tocar la base", async () => {
    const result = await setPendingObservation(
      { id: "pend-1", observation: "a".repeat(501), expectedVersion: 0, actorId: ACTOR },
      NOW,
    );
    expect(result.rejection).toBe("TOO_LONG");
    expect(findPendingObservation).not.toHaveBeenCalled();
    expect(setPendingManagementObservation).not.toHaveBeenCalled();
  });

  it("rechaza un pendiente que no existe", async () => {
    vi.mocked(findPendingObservation).mockResolvedValue(null as never);
    const result = await setPendingObservation(
      { id: "fantasma", observation: "Hola", expectedVersion: 0, actorId: ACTOR },
      NOW,
    );
    expect(result.rejection).toBe("NOT_FOUND");
    expect(setPendingManagementObservation).not.toHaveBeenCalled();
  });
});
