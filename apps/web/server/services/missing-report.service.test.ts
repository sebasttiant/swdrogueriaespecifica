import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo } = vi.hoisted(() => ({
  repo: {
    createMissingReport: vi.fn(),
    groupPendingReportsByName: vi.fn(),
    listPendingReportsForNames: vi.fn(),
  },
}));

vi.mock("@/server/repositories/missing-report.repository", () => repo);

import {
  getMissingReportQueue,
  MissingReportEmptyNameError,
  submitMissingReport,
} from "./missing-report.service";

beforeEach(() => {
  vi.clearAllMocks();
  repo.createMissingReport.mockImplementation((data: unknown) => ({
    id: "report-1",
    ...(data as object),
  }));
  repo.groupPendingReportsByName.mockResolvedValue([]);
  repo.listPendingReportsForNames.mockResolvedValue([]);
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

// Cola de revisión de gerencia. Agrupa por nombre normalizado para no repetir
// el mismo producto reportado por varios vendedores, pero conserva cada reporte.
describe("getMissingReportQueue", () => {
  function group(normalizedName: string, count: number, latest: string) {
    return { normalizedName, count, latestReportedAt: new Date(latest) };
  }

  function report(
    id: string,
    normalizedName: string,
    rawName: string,
    createdAt: string,
    reporterName: string | null = "Ana",
  ) {
    return {
      id,
      rawName,
      normalizedName,
      createdAt: new Date(createdAt),
      reporter: reporterName ? { id: `u-${id}`, name: reporterName } : null,
    };
  }

  it("asks for one extra group to know whether there is a next page", async () => {
    await getMissingReportQueue({ page: 1, pageSize: 20 });

    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 21 });
  });

  it("translates the page number into the right offset", async () => {
    await getMissingReportQueue({ page: 3, pageSize: 20 });

    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 40, take: 21 });
  });

  it("reports hasMore and trims the extra group off the page", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([
      group("a", 1, "2026-07-10"),
      group("b", 1, "2026-07-09"),
      group("c", 1, "2026-07-08"),
    ]);
    // Solo se piden los reportes de la página (a, b): el grupo extra "c" existe
    // únicamente para detectar que hay página siguiente.
    repo.listPendingReportsForNames.mockResolvedValue([
      report("ra", "a", "A", "2026-07-10"),
      report("rb", "b", "B", "2026-07-09"),
    ]);

    const queue = await getMissingReportQueue({ page: 1, pageSize: 2 });

    expect(queue.hasMore).toBe(true);
    expect(queue.groups).toHaveLength(2);
    expect(queue.groups.map((g) => g.normalizedName)).toEqual(["a", "b"]);
  });

  it("reports hasMore false when the page is not full", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([group("a", 1, "2026-07-10")]);

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20 });

    expect(queue.hasMore).toBe(false);
  });

  it("only asks for the reports of the groups on this page", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([
      group("acetaminofén", 2, "2026-07-10"),
      group("ibuprofeno", 1, "2026-07-09"),
      group("gasa", 1, "2026-07-08"),
    ]);

    await getMissingReportQueue({ page: 1, pageSize: 2 });

    expect(repo.listPendingReportsForNames).toHaveBeenCalledWith([
      "acetaminofén",
      "ibuprofeno",
    ]);
  });

  // El nombre visible es el del reporte más reciente del grupo: se muestra tal
  // como lo pegó el vendedor, no la forma normalizada (que es interna).
  it("shows the most recent original name and keeps the count of reports", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([group("acetaminofén", 4, "2026-07-10")]);
    repo.listPendingReportsForNames.mockResolvedValue([
      report("r3", "acetaminofén", "Acetaminofén 500mg", "2026-07-10"),
      report("r2", "acetaminofén", "acetaminofen", "2026-07-09"),
      report("r1", "acetaminofén", "ACETAMINOFEN", "2026-07-08"),
    ]);

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20 });

    expect(queue.groups[0]!.displayName).toBe("Acetaminofén 500mg");
    expect(queue.groups[0]!.count).toBe(4);
    expect(queue.groups[0]!.normalizedName).toBe("acetaminofén");
  });

  // Contar reportes NO es sumar cantidades: MissingReport no tiene cantidad.
  it("counts reports rather than summing any quantity", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([group("gasa", 3, "2026-07-10")]);
    repo.listPendingReportsForNames.mockResolvedValue([
      report("r1", "gasa", "Gasa", "2026-07-10"),
      report("r2", "gasa", "gasa", "2026-07-09"),
      report("r3", "gasa", "GASA", "2026-07-08"),
    ]);

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20 });

    expect(queue.groups[0]!.count).toBe(3);
    expect(queue.groups[0]!.reports).toHaveLength(3);
    const serialized = JSON.stringify(queue.groups[0]);
    expect(serialized).not.toContain("quantity");
  });

  // Cada reportante se conserva: la agrupación no borra el historial individual.
  it("keeps every reporter and date in the group's history", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([group("gasa", 2, "2026-07-10")]);
    repo.listPendingReportsForNames.mockResolvedValue([
      report("r1", "gasa", "Gasa", "2026-07-10", "Ana"),
      report("r2", "gasa", "gasa", "2026-07-09", "Beto"),
    ]);

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20 });

    expect(queue.groups[0]!.reports.map((r) => r.reporter?.name)).toEqual(["Ana", "Beto"]);
    expect(queue.groups[0]!.reports.map((r) => r.rawName)).toEqual(["Gasa", "gasa"]);
  });

  it("assigns each report to its own group", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([
      group("gasa", 1, "2026-07-10"),
      group("ibuprofeno", 1, "2026-07-09"),
    ]);
    repo.listPendingReportsForNames.mockResolvedValue([
      report("r1", "gasa", "Gasa", "2026-07-10"),
      report("r2", "ibuprofeno", "Ibuprofeno", "2026-07-09"),
    ]);

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20 });

    expect(queue.groups[0]!.reports.map((r) => r.id)).toEqual(["r1"]);
    expect(queue.groups[1]!.reports.map((r) => r.id)).toEqual(["r2"]);
  });

  it("tolerates a report whose reporter relation does not resolve", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([group("gasa", 1, "2026-07-10")]);
    repo.listPendingReportsForNames.mockResolvedValue([
      report("r1", "gasa", "Gasa", "2026-07-10", null),
    ]);

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20 });

    expect(queue.groups[0]!.reports[0]!.reporter).toBeNull();
    expect(queue.groups[0]!.displayName).toBe("Gasa");
  });

  // `pageSize` viene del llamador (en D1d-2, de la URL). Se acota con la misma
  // convención de paginación del proyecto para que nadie pida una página
  // gigante ni un `take` <= 0 (que Prisma interpreta como lectura invertida).
  it("clamps an oversized pageSize to the project maximum", async () => {
    await getMissingReportQueue({ page: 1, pageSize: 5000 });

    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 101 });
  });

  it("clamps a zero or negative pageSize to at least one", async () => {
    await getMissingReportQueue({ page: 1, pageSize: 0 });
    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 2 });

    repo.groupPendingReportsByName.mockClear();
    await getMissingReportQueue({ page: 1, pageSize: -10 });
    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 2 });
  });

  it("clamps page zero or negative to the first page", async () => {
    await getMissingReportQueue({ page: 0, pageSize: 20 });
    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 21 });

    repo.groupPendingReportsByName.mockClear();
    await getMissingReportQueue({ page: -3, pageSize: 20 });
    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 21 });
  });

  // Carrera entre las dos lecturas: el groupBy vio reportes pendientes que, al
  // pedir el historial, ya no lo están. Mostrar el grupo dejaría el nombre
  // NORMALIZADO interno como si fuera el del producto, así que se omite.
  it("drops a group whose reports are no longer pending, instead of showing the internal name", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([
      group("gasa", 1, "2026-07-10"),
      group("ibuprofeno", 2, "2026-07-09"),
    ]);
    repo.listPendingReportsForNames.mockResolvedValue([
      report("r2", "ibuprofeno", "Ibuprofeno 400", "2026-07-09"),
    ]);

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20 });

    expect(queue.groups.map((g) => g.normalizedName)).toEqual(["ibuprofeno"]);
    expect(queue.groups[0]!.displayName).toBe("Ibuprofeno 400");
    // Nunca se filtra el nombre normalizado interno como nombre visible.
    expect(queue.groups.some((g) => g.displayName === "gasa")).toBe(false);
  });

  it("returns an empty queue without asking for reports", async () => {
    const queue = await getMissingReportQueue({ page: 1, pageSize: 20 });

    expect(queue.groups).toEqual([]);
    expect(queue.hasMore).toBe(false);
    expect(repo.listPendingReportsForNames).toHaveBeenCalledWith([]);
  });
});
