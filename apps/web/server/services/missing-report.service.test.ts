import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, tx } = vi.hoisted(() => {
  const tx = { __brand: "tx-client" as const };
  const prismaMock = {
    $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return { prismaMock, tx };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { repo } = vi.hoisted(() => ({
  repo: {
    createMissingReport: vi.fn(),
    groupPendingReportsByName: vi.fn(),
    listPendingReportsForNames: vi.fn(),
    linkMissingReports: vi.fn(),
    resolveMissingReports: vi.fn(),
  },
}));

vi.mock("@/server/repositories/missing-report.repository", () => repo);

const { productRepo } = vi.hoisted(() => ({
  productRepo: { findProductById: vi.fn(), upsertProvisionalProduct: vi.fn() },
}));
vi.mock("@/server/repositories/product.repository", () => productRepo);

const { missingItemRepo } = vi.hoisted(() => ({
  missingItemRepo: {
    createMissingItem: vi.fn(),
    findActionableMissingItemByProduct: vi.fn(),
    fillMissingItemLaboratory: vi.fn(),
  },
}));
vi.mock("@/server/repositories/missing-item.repository", () => missingItemRepo);

import {
  getMissingReportQueue,
  linkReportToProduct,
  MissingReportLinkError,
  MissingReportResolveConflictError,
  MissingReportEmptyNameError,
  submitMissingReport,
  resolveReports,
} from "./missing-report.service";

beforeEach(() => {
  vi.clearAllMocks();
  repo.createMissingReport.mockImplementation((data: unknown) => ({
    id: "report-1",
    ...(data as object),
  }));
  productRepo.findProductById.mockResolvedValue({ id: "prod-1", active: true });
  productRepo.upsertProvisionalProduct.mockResolvedValue({ id: "prod-prov-1" });
  // Por defecto NO hay faltante accionable previo: el reporte abre el suyo.
  missingItemRepo.findActionableMissingItemByProduct.mockResolvedValue(null);
  missingItemRepo.createMissingItem.mockResolvedValue({ id: "missing-1", productId: "prod-1" });
  missingItemRepo.fillMissingItemLaboratory.mockResolvedValue(true);
  repo.linkMissingReports.mockResolvedValue(["r1", "r2"]);
  repo.resolveMissingReports.mockResolvedValue(["r1", "r2"]);
  repo.groupPendingReportsByName.mockResolvedValue([]);
  repo.listPendingReportsForNames.mockResolvedValue([]);
});

describe("resolveReports · atomicity", () => {
  const input = { normalizedName: "tiamina", resolution: "ORDERED" as const, userId: "admin-1" };

  it("resolves the complete group inside one transaction with attribution", async () => {
    const now = new Date("2026-07-30T12:00:00.000Z");

    await expect(resolveReports(input, now)).resolves.toEqual({ resolved: 2, reportIds: ["r1", "r2"] });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(repo.resolveMissingReports).toHaveBeenCalledWith(
      { normalizedName: "tiamina", resolution: "ORDERED", resolvedById: "admin-1", resolvedAt: now },
      tx,
    );
  });

  it("rolls back and conflicts when the group no longer has pending reports", async () => {
    repo.resolveMissingReports.mockResolvedValueOnce([]);

    await expect(resolveReports(input)).rejects.toBeInstanceOf(MissingReportResolveConflictError);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("maps a serializable database race to the same deterministic conflict", async () => {
    prismaMock.$transaction.mockRejectedValueOnce({ code: "P2034" });

    await expect(resolveReports(input)).rejects.toBeInstanceOf(MissingReportResolveConflictError);
  });

  it("uses the canonical group key rather than client-selected report ids", async () => {
    await resolveReports(input);
    expect(repo.resolveMissingReports).toHaveBeenCalledWith(
      expect.objectContaining({ normalizedName: "tiamina" }),
      tx,
    );
  });
});

// --------------------------------------------------------------------------
// Presentación y laboratorio: lo que el vendedor PUEDA aportar.
//
// Los dos son opcionales de verdad. El vendedor reporta desde el mostrador con
// un cliente adelante: exigirle datos que a veces no conoce convierte un
// reporte de diez segundos en una fricción que termina en NO reportar, y un
// faltante sin laboratorio vale muchísimo más que un faltante que nadie cargó.
// --------------------------------------------------------------------------
describe("submitMissingReport · presentación y laboratorio", () => {
  it("lleva la presentación al producto que crea", async () => {
    await submitMissingReport({
      rawName: "Losartán 50",
      reporterId: "user-1",
      presentation: "caja x 30",
    });

    expect(productRepo.upsertProvisionalProduct).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ presentation: "caja x 30" }),
    );
  });

  it("sin presentación no inventa ninguna", async () => {
    await submitMissingReport({ rawName: "Losartán 50", reporterId: "user-1" });

    expect(productRepo.upsertProvisionalProduct).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ presentation: undefined }),
    );
  });

  it("lleva el laboratorio al faltante que abre", async () => {
    await submitMissingReport({
      rawName: "Losartán 50",
      reporterId: "user-1",
      requestedLaboratoryId: "lab-genfar",
    });

    expect(missingItemRepo.createMissingItem).toHaveBeenCalledWith(
      expect.objectContaining({ requestedLaboratoryId: "lab-genfar" }),
      tx,
    );
  });

  // Dos vendedores reportan lo mismo y comparten faltante. Si el primero no
  // sabía el laboratorio y el segundo sí, ese dato es información nueva.
  it("COMPLETA el laboratorio de un faltante que no lo tenía", async () => {
    missingItemRepo.findActionableMissingItemByProduct.mockResolvedValueOnce({
      id: "missing-existente",
      requestedLaboratoryId: null,
    });

    await submitMissingReport({
      rawName: "Losartán 50",
      reporterId: "user-2",
      requestedLaboratoryId: "lab-genfar",
    });

    expect(missingItemRepo.fillMissingItemLaboratory).toHaveBeenCalledWith(
      "missing-existente",
      "lab-genfar",
      tx,
    );
    // Se enganchó al faltante que ya estaba: no abre una segunda fila.
    expect(missingItemRepo.createMissingItem).not.toHaveBeenCalled();
  });

  // Pero si ya estaba informado, NO se toca: quien decide una compra vio un
  // laboratorio, y que se le mueva por debajo es peor que no tenerlo.
  it("NO pisa el laboratorio que otro vendedor ya había informado", async () => {
    missingItemRepo.findActionableMissingItemByProduct.mockResolvedValueOnce({
      id: "missing-existente",
      requestedLaboratoryId: "lab-la-santé",
    });

    await submitMissingReport({
      rawName: "Losartán 50",
      reporterId: "user-2",
      requestedLaboratoryId: "lab-genfar",
    });

    expect(missingItemRepo.fillMissingItemLaboratory).not.toHaveBeenCalled();
  });

  it("no toca nada cuando el reporte no trae laboratorio", async () => {
    missingItemRepo.findActionableMissingItemByProduct.mockResolvedValueOnce({
      id: "missing-existente",
      requestedLaboratoryId: null,
    });

    await submitMissingReport({ rawName: "Losartán 50", reporterId: "user-2" });

    expect(missingItemRepo.fillMissingItemLaboratory).not.toHaveBeenCalled();
  });
});

describe("submitMissingReport", () => {
  it("preserves rawName and sellerCode, and stores the normalized form for grouping", async () => {
    await submitMissingReport({
      rawName: "  Acetaminofén   500  ",
      sellerCode: "VEN-12",
      reporterId: "user-1",
    });

    expect(repo.createMissingReport).toHaveBeenCalledWith(
      expect.objectContaining({
        rawName: "  Acetaminofén   500  ",
        normalizedName: "acetaminofén 500",
        sellerCode: "VEN-12",
        reporterId: "user-1",
      }),
      tx,
    );
  });

  it("takes the reporterId straight through to persistence", async () => {
    await submitMissingReport({ rawName: "Ibuprofeno", reporterId: "seller-9" });

    const arg = repo.createMissingReport.mock.calls[0]![0] as { reporterId: string };
    expect(arg.reporterId).toBe("seller-9");
  });

  // Lo que pidió gerencia el 2026-10-04: el reporte YA ES el faltante. Nace en
  // la cola accionable, sin paso intermedio de revisión.
  it("crea el faltante accionable en la misma transacción, no un reporte a revisar", async () => {
    missingItemRepo.createMissingItem.mockResolvedValue({ id: "missing-9" });

    await submitMissingReport({ rawName: "Tiamina", sellerCode: "VEN-3", reporterId: "user-1" });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(productRepo.upsertProvisionalProduct).toHaveBeenCalledWith(tx, {
      normalizedName: "tiamina",
      displayName: "Tiamina",
    });
    expect(missingItemRepo.createMissingItem).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "prod-prov-1",
        // Default de negocio: el formulario no pide cantidad.
        quantity: 1,
        originId: null,
        createdById: "user-1",
        sellerCode: "VEN-3",
      }),
      tx,
    );
    // El reporte queda LINKED y apuntando: es la trazabilidad reportante→faltante.
    expect(repo.createMissingReport).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "LINKED",
        linkedProductId: "prod-prov-1",
        linkedMissingItemId: "missing-9",
      }),
      tx,
    );
  });

  // Dos vendedores que reportan lo mismo NO generan dos filas en "Por pedir":
  // el segundo se engancha al faltante que abrió el primero. Los dos reportes
  // se conservan enteros.
  it("engancha el reporte al faltante accionable que ya existe, sin duplicarlo", async () => {
    missingItemRepo.findActionableMissingItemByProduct.mockResolvedValue({ id: "missing-existente" });

    await submitMissingReport({ rawName: "Acetaminofén", reporterId: "user-2" });

    expect(missingItemRepo.createMissingItem).not.toHaveBeenCalled();
    expect(repo.createMissingReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reporterId: "user-2",
        linkedMissingItemId: "missing-existente",
      }),
      tx,
    );
  });

  // Cada reporte sigue siendo su propia fila —quién y cuándo no se pierde—
  // aunque compartan el faltante.
  it("persists each report independently for names that normalize equal", async () => {
    await submitMissingReport({ rawName: "Acetaminofén", reporterId: "user-1" });
    await submitMissingReport({ rawName: "acetaminofen", reporterId: "user-2" });

    expect(repo.createMissingReport).toHaveBeenCalledTimes(2);
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
    // Ni siquiera se abre la transacción: no queda producto provisional huérfano.
    expect(productRepo.upsertProvisionalProduct).not.toHaveBeenCalled();
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
    await getMissingReportQueue({ page: 1, pageSize: 20, scope: "pending" });

    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 21, status: "PENDING_REVIEW" });
  });

  it("translates the page number into the right offset", async () => {
    await getMissingReportQueue({ page: 3, pageSize: 20, scope: "pending" });

    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 40, take: 21, status: "PENDING_REVIEW" });
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

    const queue = await getMissingReportQueue({ page: 1, pageSize: 2, scope: "pending" });

    expect(queue.hasMore).toBe(true);
    expect(queue.groups).toHaveLength(2);
    expect(queue.groups.map((g) => g.normalizedName)).toEqual(["a", "b"]);
  });

  it("reports hasMore false when the page is not full", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([group("a", 1, "2026-07-10")]);

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20, scope: "pending" });

    expect(queue.hasMore).toBe(false);
  });

  it("only asks for the reports of the groups on this page", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([
      group("acetaminofén", 2, "2026-07-10"),
      group("ibuprofeno", 1, "2026-07-09"),
      group("gasa", 1, "2026-07-08"),
    ]);

    await getMissingReportQueue({ page: 1, pageSize: 2, scope: "pending" });

    expect(repo.listPendingReportsForNames).toHaveBeenCalledWith(
      ["acetaminofén", "ibuprofeno"],
      "PENDING_REVIEW",
    );
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

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20, scope: "pending" });

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

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20, scope: "pending" });

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

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20, scope: "pending" });

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

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20, scope: "pending" });

    expect(queue.groups[0]!.reports.map((r) => r.id)).toEqual(["r1"]);
    expect(queue.groups[1]!.reports.map((r) => r.id)).toEqual(["r2"]);
  });

  it("tolerates a report whose reporter relation does not resolve", async () => {
    repo.groupPendingReportsByName.mockResolvedValue([group("gasa", 1, "2026-07-10")]);
    repo.listPendingReportsForNames.mockResolvedValue([
      report("r1", "gasa", "Gasa", "2026-07-10", null),
    ]);

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20, scope: "pending" });

    expect(queue.groups[0]!.reports[0]!.reporter).toBeNull();
    expect(queue.groups[0]!.displayName).toBe("Gasa");
  });

  // `pageSize` viene del llamador (en D1d-2, de la URL). Se acota con la misma
  // convención de paginación del proyecto para que nadie pida una página
  // gigante ni un `take` <= 0 (que Prisma interpreta como lectura invertida).
  it("clamps an oversized pageSize to the project maximum", async () => {
    await getMissingReportQueue({ page: 1, pageSize: 5000, scope: "pending" });

    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 101, status: "PENDING_REVIEW" });
  });

  it("clamps a zero or negative pageSize to at least one", async () => {
    await getMissingReportQueue({ page: 1, pageSize: 0, scope: "pending" });
    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 2, status: "PENDING_REVIEW" });

    repo.groupPendingReportsByName.mockClear();
    await getMissingReportQueue({ page: 1, pageSize: -10, scope: "pending" });
    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 2, status: "PENDING_REVIEW" });
  });

  it("clamps page zero or negative to the first page", async () => {
    await getMissingReportQueue({ page: 0, pageSize: 20, scope: "pending" });
    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 21, status: "PENDING_REVIEW" });

    repo.groupPendingReportsByName.mockClear();
    await getMissingReportQueue({ page: -3, pageSize: 20, scope: "pending" });
    expect(repo.groupPendingReportsByName).toHaveBeenCalledWith({ skip: 0, take: 21, status: "PENDING_REVIEW" });
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

    const queue = await getMissingReportQueue({ page: 1, pageSize: 20, scope: "pending" });

    expect(queue.groups.map((g) => g.normalizedName)).toEqual(["ibuprofeno"]);
    expect(queue.groups[0]!.displayName).toBe("Ibuprofeno 400");
    // Nunca se filtra el nombre normalizado interno como nombre visible.
    expect(queue.groups.some((g) => g.displayName === "gasa")).toBe(false);
  });

  it("returns an empty queue without asking for reports", async () => {
    const queue = await getMissingReportQueue({ page: 1, pageSize: 20, scope: "pending" });

    expect(queue.groups).toEqual([]);
    expect(queue.hasMore).toBe(false);
    expect(repo.listPendingReportsForNames).toHaveBeenCalledWith([], "PENDING_REVIEW");
  });
});

describe("linkReportToProduct", () => {
  const input = { normalizedName: "tiamina", productId: "prod-1", userId: "admin-1" };

  it("creates exactly ONE faltante for the whole group", async () => {
    await linkReportToProduct(input);

    expect(missingItemRepo.createMissingItem).toHaveBeenCalledTimes(1);
  });

  // `quantity: 1` es un placeholder deliberado: gerencia define la cantidad real
  // al pedir (`orderedQuantity`, desde C2Q). Cero rompería el cierre FIFO, que
  // trata `quantity <= remaining` como "cubierto" y lo cerraría con cualquier
  // entrada.
  it("creates the faltante with the placeholder quantity and the seller-report note", async () => {
    await linkReportToProduct(input);

    expect(missingItemRepo.createMissingItem).toHaveBeenCalledWith(
      {
        productId: "prod-1",
        quantity: 1,
        originId: null,
        createdById: "admin-1",
        note: "Generado desde reporte de vendedor",
      },
      tx,
    );
  });

  it("links the whole group to the product and the new faltante", async () => {
    await linkReportToProduct(input);

    expect(repo.linkMissingReports).toHaveBeenCalledWith(
      {
        normalizedName: "tiamina",
        productId: "prod-1",
        missingItemId: "missing-1",
      },
      tx,
    );
  });

  it("returns the faltante and how many reports were linked", async () => {
    repo.linkMissingReports.mockResolvedValue(["r1", "r2"]);

    const result = await linkReportToProduct(input);

    expect(result.missingItem).toMatchObject({ id: "missing-1" });
    expect(result.linkedReportsCount).toBe(2);
  });

  it("rejects an unknown product without creating anything", async () => {
    productRepo.findProductById.mockResolvedValue(null);

    await expect(linkReportToProduct(input)).rejects.toBeInstanceOf(MissingReportLinkError);
    expect(missingItemRepo.createMissingItem).not.toHaveBeenCalled();
    expect(repo.linkMissingReports).not.toHaveBeenCalled();
  });

  // Un producto inactivo no puede recibir un faltante nuevo: es la misma regla
  // que ya aplica el alta manual catalogada.
  it("rejects an inactive product without creating anything", async () => {
    productRepo.findProductById.mockResolvedValue({ id: "prod-1", active: false });

    await expect(linkReportToProduct(input)).rejects.toBeInstanceOf(MissingReportLinkError);
    expect(missingItemRepo.createMissingItem).not.toHaveBeenCalled();
  });

  it("validates the product BEFORE creating the faltante", async () => {
    const order: string[] = [];
    productRepo.findProductById.mockImplementation(async () => {
      order.push("product");
      return { id: "prod-1", active: true };
    });
    missingItemRepo.createMissingItem.mockImplementation(async () => {
      order.push("create");
      return { id: "missing-1" };
    });

    await linkReportToProduct(input);

    expect(order).toEqual(["product", "create"]);
  });

  // Carrera: otro gerente vinculó el grupo primero. El CAS del repositorio no
  // escribe ninguna fila y el service lo reporta en vez de fingir éxito.
  it("rejects when no report was still pending review", async () => {
    repo.linkMissingReports.mockResolvedValue([]);

    await expect(linkReportToProduct(input)).rejects.toBeInstanceOf(MissingReportLinkError);
  });
});

describe("linkReportToProduct · atomicity", () => {
  const input = { normalizedName: "tiamina", productId: "prod-1", userId: "admin-1" };

  beforeEach(() => {
    prismaMock.$transaction.mockImplementation(
      (fn: (client: typeof tx) => unknown) => fn(tx),
    );
    // Un solo reporte en el grupo: la escritura debe cubrirlo entero.
    repo.linkMissingReports.mockResolvedValue(["r1"]);
  });

  // Crear el faltante y marcar los reportes tiene que ser TODO o NADA. Sin la
  // transacción, perder la carrera dejaba un faltante huérfano ya creado, sin
  // ningún reporte apuntándole y visible en /faltantes.
  it("creates the faltante and links the reports inside ONE transaction", async () => {
    await linkReportToProduct(input);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(missingItemRepo.createMissingItem).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "prod-1" }),
      tx,
    );
    expect(repo.linkMissingReports).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "prod-1" }),
      tx,
    );
  });

  // Al perder la carrera, el throw revierte la transacción: el faltante creado
  // dentro de ella NO queda persistido.
  it("rolls back the created faltante when the group was already linked", async () => {
    repo.linkMissingReports.mockResolvedValue([]);

    await expect(linkReportToProduct(input)).rejects.toBeInstanceOf(
      MissingReportLinkError,
    );
    // El error escapa de la transacción, que es lo que fuerza el rollback.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("linkReportToProduct · partial link", () => {
  beforeEach(() => {
    prismaMock.$transaction.mockImplementation(
      (fn: (client: typeof tx) => unknown) => fn(tx),
    );
  });

  // El caso peligroso: parte del grupo ya fue vinculada por otro gerente. Si se
  // aceptara, el grupo quedaría partido entre DOS faltantes en silencio.
  it("rejects when only SOME of the group was still pending review", async () => {
    repo.linkMissingReports.mockResolvedValue([]);

    await expect(
      linkReportToProduct({
        normalizedName: "tiamina",
        productId: "prod-1",
        userId: "admin-1",
      }),
    ).rejects.toBeInstanceOf(MissingReportLinkError);
  });

  it("accepts only when every report in the group was linked", async () => {
    repo.linkMissingReports.mockResolvedValue(["r1", "r2", "r3"]);

    const result = await linkReportToProduct({
        normalizedName: "tiamina",
      productId: "prod-1",
      userId: "admin-1",
    });

    expect(result.linkedReportsCount).toBe(3);
  });

  it("returns the server-selected report count", async () => {
    repo.linkMissingReports.mockResolvedValue(["r1", "r2"]);

    const result = await linkReportToProduct({
        normalizedName: "tiamina",
      productId: "prod-1",
      userId: "admin-1",
    });

    expect(result.linkedReportsCount).toBe(2);
    expect(repo.linkMissingReports).toHaveBeenCalledWith(
      expect.objectContaining({ normalizedName: "tiamina" }),
      tx,
    );
  });
});
