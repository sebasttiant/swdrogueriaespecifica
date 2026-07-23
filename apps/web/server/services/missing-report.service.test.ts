import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo } = vi.hoisted(() => ({
  repo: { createMissingReport: vi.fn() },
}));

vi.mock("@/server/repositories/missing-report.repository", () => repo);

import {
  MissingReportEmptyNameError,
  submitMissingReport,
} from "./missing-report.service";

beforeEach(() => {
  vi.clearAllMocks();
  repo.createMissingReport.mockImplementation((data: unknown) => ({
    id: "report-1",
    ...(data as object),
  }));
});

describe("submitMissingReport", () => {
  it("preserves rawName and stores the normalized form for grouping", async () => {
    await submitMissingReport({ rawName: "  Acetaminofén   500  ", reporterId: "user-1" });

    expect(repo.createMissingReport).toHaveBeenCalledWith({
      rawName: "  Acetaminofén   500  ",
      normalizedName: "acetaminofén 500",
      reporterId: "user-1",
    });
  });

  it("takes the reporterId straight through to persistence", async () => {
    await submitMissingReport({ rawName: "Ibuprofeno", reporterId: "seller-9" });

    const arg = repo.createMissingReport.mock.calls[0]![0] as { reporterId: string };
    expect(arg.reporterId).toBe("seller-9");
  });

  // Dos nombres que normalizan igual se guardan como reportes independientes:
  // el service no deduplica ni suma nada (MissingReport no tiene cantidad).
  it("persists each report independently for names that normalize equal", async () => {
    await submitMissingReport({ rawName: "Acetaminofén", reporterId: "user-1" });
    await submitMissingReport({ rawName: "acetaminofen", reporterId: "user-2" });

    expect(repo.createMissingReport).toHaveBeenCalledTimes(2);
    // Mismo normalizedName base ("acetaminof..") pero dos filas distintas.
    expect(repo.createMissingReport.mock.calls[0]![0]).toMatchObject({ reporterId: "user-1" });
    expect(repo.createMissingReport.mock.calls[1]![0]).toMatchObject({ reporterId: "user-2" });
  });

  // El disparador REAL del guard: un nombre de solo caracteres de control. El
  // `trim().min(1)` de Zod no los elimina (los deja pasar), pero el normalizador
  // los reduce a vacío. El dominio lo rechaza antes de persistir. (Que ese input
  // efectivamente pase Zod se afirma en schema.test.ts.)
  it("rejects a control-character-only name that normalizes to empty, without persisting", async () => {
    await expect(
      submitMissingReport({ rawName: "\u0000\u0001\u001f", reporterId: "user-1" }),
    ).rejects.toBeInstanceOf(MissingReportEmptyNameError);

    expect(repo.createMissingReport).not.toHaveBeenCalled();
  });

  // Un nombre de solo espacios también normaliza a vacío y se rechaza (defensa
  // en profundidad: aunque Zod ya lo cortaría, el service no confía en eso).
  it("rejects a whitespace-only name that normalizes to empty", async () => {
    await expect(
      submitMissingReport({ rawName: "   ", reporterId: "user-1" }),
    ).rejects.toBeInstanceOf(MissingReportEmptyNameError);

    expect(repo.createMissingReport).not.toHaveBeenCalled();
  });

  it("returns the persisted report", async () => {
    const report = await submitMissingReport({ rawName: "Gasa", reporterId: "user-1" });
    expect(report).toMatchObject({ id: "report-1", reporterId: "user-1" });
  });
});
