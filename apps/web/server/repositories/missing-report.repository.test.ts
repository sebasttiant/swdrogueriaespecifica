import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    missingReport: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { createMissingReport } from "./missing-report.repository";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.missingReport.create.mockImplementation(({ data }: { data: unknown }) => ({
    id: "report-1",
    ...(data as object),
  }));
});

describe("createMissingReport", () => {
  it("persists rawName, normalizedName and reporterId", async () => {
    await createMissingReport({
      rawName: "Acetaminofén 500",
      normalizedName: "acetaminofén 500",
      reporterId: "user-1",
    });

    expect(prismaMock.missingReport.create).toHaveBeenCalledWith({
      data: {
        rawName: "Acetaminofén 500",
        normalizedName: "acetaminofén 500",
        reporterId: "user-1",
      },
    });
  });

  // El status por defecto (PENDING_REVIEW) lo pone el schema, no el repositorio:
  // no debe forzarse acá para no acoplar la capa a un estado concreto.
  it("does not set status, letting the schema default apply", async () => {
    await createMissingReport({
      rawName: "Ibuprofeno",
      normalizedName: "ibuprofeno",
      reporterId: "user-1",
    });

    const arg = prismaMock.missingReport.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data).not.toHaveProperty("status");
  });

  // Dos reportes iguales son dos filas: no hay unique ni upsert que los una.
  // MissingReport no tiene cantidad, así que no hay nada que sumar.
  it("creates an independent row per call, even for the same normalized name", async () => {
    await createMissingReport({
      rawName: "Acetaminofén",
      normalizedName: "acetaminofén",
      reporterId: "user-1",
    });
    await createMissingReport({
      rawName: "acetaminofen",
      normalizedName: "acetaminofen",
      reporterId: "user-2",
    });

    expect(prismaMock.missingReport.create).toHaveBeenCalledTimes(2);
  });
});
