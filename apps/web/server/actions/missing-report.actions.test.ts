import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  submitMissingReport: vi.fn(),
  linkReportToProduct: vi.fn(),
  resolveReports: vi.fn(),
  recordAudit: vi.fn(),
  auditContextFromHeaders: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/require-role", () => ({ requireCapability: mocks.requireCapability }));
vi.mock("@/server/services/audit.service", () => ({
  auditContextFromHeaders: mocks.auditContextFromHeaders,
  recordAudit: mocks.recordAudit,
}));
vi.mock("@/server/services/missing-report.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/missing-report.service")>();
  return {
    ...actual,
    submitMissingReport: mocks.submitMissingReport,
    linkReportToProduct: mocks.linkReportToProduct,
    resolveReports: mocks.resolveReports,
  };
});

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  MissingReportEmptyNameError,
  MissingReportLinkError,
  MissingReportResolveConflictError,
} from "@/server/services/missing-report.service";
import {
  createMissingReportAction,
  linkMissingReportToProductAction,
  resolveMissingReportsAction,
} from "./missing-report.actions";

const PREV = { error: null, ok: false };

function reportFormData(rawName = "Acetaminofén 500", extra: Record<string, string> = {}) {
  const data = new FormData();
  data.set("rawName", rawName);
  for (const [k, v] of Object.entries(extra)) data.set(k, v);
  return data;
}

function grant(role: "SUPERADMIN" | "ADMIN" | "SUPERVISOR" | "OPERADOR", allowed: readonly string[]) {
  mocks.requireCapability.mockImplementation((capability: string) => {
    if (allowed.includes(capability)) {
      return Promise.resolve({ user: { id: `${role.toLowerCase()}-1`, role } });
    }
    return Promise.reject(new Error("REDIRECT:/dashboard"));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditContextFromHeaders.mockResolvedValue({ userId: "op-1", channel: "web" });
  mocks.submitMissingReport.mockResolvedValue({ id: "report-1", reporterId: "operador-1" });
  mocks.linkReportToProduct.mockResolvedValue({
    missingItem: { id: "missing-1" },
    linkedReportsCount: 2,
  });
  mocks.resolveReports.mockResolvedValue({ resolved: 2, reportIds: ["r1", "r2"] });
});

function resolveFormData(normalizedName = "tiamina", resolution = "ORDERED") {
  const data = new FormData();
  data.set("normalizedName", normalizedName);
  data.set("resolution", resolution);
  return data;
}

describe("resolveMissingReportsAction", () => {
  it("requires review capability before attempting a mutation", async () => {
    grant("OPERADOR", []);

    await expect(resolveMissingReportsAction(PREV, resolveFormData())).rejects.toThrow(
      "REDIRECT:/dashboard",
    );
    expect(mocks.resolveReports).not.toHaveBeenCalled();
  });

  it("rejects an empty or invalid resolution before the service", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);

    expect((await resolveMissingReportsAction(PREV, resolveFormData(""))).ok).toBe(false);
    expect(
      (await resolveMissingReportsAction(PREV, resolveFormData("tiamina", "LINKED"))).ok,
    ).toBe(false);
    expect(mocks.resolveReports).not.toHaveBeenCalled();
  });

  it("uses the session user, audits exact report ids without PII, and revalidates", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);

    await expect(resolveMissingReportsAction(PREV, resolveFormData())).resolves.toEqual({
      error: null,
      ok: true,
    });
    expect(mocks.resolveReports).toHaveBeenCalledWith({
      normalizedName: "tiamina",
      resolution: "ORDERED",
      userId: "admin-1",
    });
    const audit = mocks.recordAudit.mock.calls[0]![0];
    expect(audit).toMatchObject({
      action: AUDIT_ACTIONS.MISSING_REPORT_ORDERED,
      module: AUDIT_MODULES.FALTANTES,
      entity: "MissingReport",
      after: { status: "ORDERED", reportIds: ["r1", "r2"], reportCount: 2 },
    });
    expect(JSON.stringify(audit)).not.toContain("rawName");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/revision-faltantes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
  });

  it.each([0, 1])("maps a zero or partial group resolution to a conflict", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);
    mocks.resolveReports.mockRejectedValueOnce(new MissingReportResolveConflictError());

    await expect(resolveMissingReportsAction(PREV, resolveFormData())).resolves.toEqual({
      error: "Estos reportes ya fueron revisados. Actualizá la cola.",
      ok: false,
    });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("returns a retryable error only when persistence fails before a mutation", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);
    mocks.resolveReports.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(resolveMissingReportsAction(PREV, resolveFormData())).resolves.toEqual({
      error: "No se pudo resolver. Intentá de nuevo.",
      ok: false,
    });
  });

  it.each(["audit", "headers", "revalidate"])(
    "keeps confirmed resolution successful when %s fails post-commit",
    async (failure) => {
      grant("ADMIN", ["canReviewMissingReports"]);
      if (failure === "audit") mocks.recordAudit.mockRejectedValueOnce(new Error("audit unavailable"));
      if (failure === "headers") mocks.auditContextFromHeaders.mockRejectedValueOnce(new Error("headers unavailable"));
      if (failure === "revalidate") mocks.revalidatePath.mockImplementationOnce(() => {
        throw new Error("cache unavailable");
      });

      await expect(resolveMissingReportsAction(PREV, resolveFormData())).resolves.toEqual({
        error: null,
        ok: true,
      });
    },
  );
});

describe("createMissingReportAction", () => {
  it("guards with canSubmitMissingReports before doing anything", async () => {
    grant("OPERADOR", []); // no tiene la capability

    await expect(createMissingReportAction(PREV, reportFormData())).rejects.toThrow(
      "REDIRECT:/dashboard",
    );
    expect(mocks.requireCapability).toHaveBeenCalledWith("canSubmitMissingReports");
    expect(mocks.submitMissingReport).not.toHaveBeenCalled();
  });

  it("lets OPERADOR submit a report", async () => {
    grant("OPERADOR", ["canSubmitMissingReports"]);

    await expect(createMissingReportAction(PREV, reportFormData())).resolves.toEqual({
      error: null,
      ok: true,
    });
    expect(mocks.submitMissingReport).toHaveBeenCalledTimes(1);
  });

  // reporterId SIEMPRE de la sesión. Un `reporterId` inyectado por FormData no
  // debe influir en lo que se persiste.
  it("takes reporterId from the session and ignores any FormData reporterId", async () => {
    grant("OPERADOR", ["canSubmitMissingReports"]);

    await createMissingReportAction(
      PREV,
      reportFormData("Gasa", { reporterId: "attacker-999" }),
    );

    expect(mocks.submitMissingReport).toHaveBeenCalledWith({
      rawName: "Gasa",
      sellerCode: undefined,
      reporterId: "operador-1",
    });
    const arg = mocks.submitMissingReport.mock.calls[0]![0] as { reporterId: string };
    expect(arg.reporterId).not.toBe("attacker-999");
  });

  it("passes the optional sellerCode from FormData to the service", async () => {
    grant("OPERADOR", ["canSubmitMissingReports"]);

    await createMissingReportAction(PREV, reportFormData("Gasa", { sellerCode: "VEN-12" }));

    expect(mocks.submitMissingReport).toHaveBeenCalledWith({
      rawName: "Gasa",
      sellerCode: "VEN-12",
      reporterId: "operador-1",
    });
  });

  it("rejects an empty name before persisting", async () => {
    grant("OPERADOR", ["canSubmitMissingReports"]);

    const result = await createMissingReportAction(PREV, reportFormData(""));

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(mocks.submitMissingReport).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("surfaces the too-long message for an oversized name, before persisting", async () => {
    grant("OPERADOR", ["canSubmitMissingReports"]);

    const result = await createMissingReportAction(PREV, reportFormData("a".repeat(201)));

    expect(result.ok).toBe(false);
    expect(result.error).toBe("El nombre del producto es demasiado largo.");
    expect(mocks.submitMissingReport).not.toHaveBeenCalled();
  });

  it("maps a name that normalizes to empty to a validation error, not a server error", async () => {
    grant("OPERADOR", ["canSubmitMissingReports"]);
    mocks.submitMissingReport.mockRejectedValueOnce(new MissingReportEmptyNameError());

    const result = await createMissingReportAction(PREV, reportFormData("."));

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Escribí el nombre del producto.");
  });

  it("audits with safe metadata: the report id, status and name length, never the raw name", async () => {
    grant("OPERADOR", ["canSubmitMissingReports"]);

    await createMissingReportAction(PREV, reportFormData("Acetaminofén 500"));

    expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
    const audit = mocks.recordAudit.mock.calls[0]![0];
    expect(audit).toMatchObject({
      action: AUDIT_ACTIONS.MISSING_REPORT_CREATE,
      module: AUDIT_MODULES.FALTANTES,
      entity: "MissingReport",
      entityId: "report-1",
      after: { status: "PENDING_REVIEW", nameLength: "Acetaminofén 500".length },
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("Acetaminofén 500");
  });

  // El reporte YA se persistió. Un fallo posterior de auditoría no debe decirle
  // al vendedor que falló: reintentaría y crearía un duplicado accidental.
  it("reports success when auditing fails after the report was persisted", async () => {
    grant("OPERADOR", ["canSubmitMissingReports"]);
    mocks.recordAudit.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(createMissingReportAction(PREV, reportFormData())).resolves.toEqual({
      error: null,
      ok: true,
    });
    expect(mocks.submitMissingReport).toHaveBeenCalledTimes(1);
  });

  it("reports success when revalidation fails after the report was persisted", async () => {
    grant("OPERADOR", ["canSubmitMissingReports"]);
    mocks.revalidatePath.mockImplementationOnce(() => {
      throw new Error("cache unavailable");
    });

    await expect(createMissingReportAction(PREV, reportFormData())).resolves.toEqual({
      error: null,
      ok: true,
    });
  });

  it("returns a generic error when persistence itself fails", async () => {
    grant("OPERADOR", ["canSubmitMissingReports"]);
    mocks.submitMissingReport.mockRejectedValueOnce(new Error("db down"));

    const result = await createMissingReportAction(PREV, reportFormData());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("No se pudo enviar el reporte. Intentá de nuevo.");
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
});

function linkFormData(
  normalizedName = "tiamina",
  productId = "prod-1",
  extra: Record<string, string> = {},
) {
  const data = new FormData();
  data.set("normalizedName", normalizedName);
  data.set("productId", productId);
  for (const [k, v] of Object.entries(extra)) data.set(k, v);
  return data;
}

describe("linkMissingReportToProductAction", () => {
  it("guards with canReviewMissingReports before doing anything", async () => {
    grant("OPERADOR", ["canSubmitMissingReports"]); // reporta, pero no revisa

    await expect(
      linkMissingReportToProductAction(PREV, linkFormData()),
    ).rejects.toThrow("REDIRECT:/dashboard");
    expect(mocks.requireCapability).toHaveBeenCalledWith("canReviewMissingReports");
    expect(mocks.linkReportToProduct).not.toHaveBeenCalled();
  });

  it("rejects SUPERVISOR, who can report but not review", async () => {
    grant("SUPERVISOR", ["canSubmitMissingReports"]);

    await expect(
      linkMissingReportToProductAction(PREV, linkFormData()),
    ).rejects.toThrow("REDIRECT:/dashboard");
    expect(mocks.linkReportToProduct).not.toHaveBeenCalled();
  });

  it("lets ADMIN link a group, returning the new faltante id", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);

    await expect(
      linkMissingReportToProductAction(PREV, linkFormData()),
    ).resolves.toEqual({ error: null, ok: true, missingItemId: "missing-1" });
  });

  // El usuario que vincula SIEMPRE sale de la sesión: un userId inyectado por
  // FormData no debe influir.
  it("takes the linking user from the session, ignoring any FormData userId", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);

    await linkMissingReportToProductAction(
      PREV,
      linkFormData("tiamina", "prod-1", { userId: "attacker-999" }),
    );

    expect(mocks.linkReportToProduct).toHaveBeenCalledWith({
      normalizedName: "tiamina",
      productId: "prod-1",
      userId: "admin-1",
    });
  });

  it("rejects an empty report list or a missing product before touching the service", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);

    const noReports = await linkMissingReportToProductAction(PREV, linkFormData(""));
    expect(noReports.ok).toBe(false);

    const noProduct = await linkMissingReportToProductAction(
      PREV,
      linkFormData("tiamina", ""),
    );
    expect(noProduct.ok).toBe(false);
    expect(mocks.linkReportToProduct).not.toHaveBeenCalled();
  });

  it("maps an unknown or inactive product to a readable error", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);
    mocks.linkReportToProduct.mockRejectedValueOnce(
      new MissingReportLinkError("PRODUCT_NOT_FOUND", "nope"),
    );

    const result = await linkMissingReportToProductAction(PREV, linkFormData());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("El producto no existe o está inactivo.");
  });

  it("maps a group someone else already reviewed to a readable error", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);
    mocks.linkReportToProduct.mockRejectedValueOnce(
      new MissingReportLinkError("ALREADY_LINKED", "nope"),
    );

    const result = await linkMissingReportToProductAction(PREV, linkFormData());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Estos reportes ya fueron revisados. Actualizá la cola.");
  });

  it("audits the link with safe metadata only: no reporter names", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);

    await linkMissingReportToProductAction(PREV, linkFormData());

    const audit = mocks.recordAudit.mock.calls[0]![0];
    expect(audit).toMatchObject({
      action: AUDIT_ACTIONS.MISSING_REPORT_LINKED,
      module: AUDIT_MODULES.FALTANTES,
      entity: "MissingReport",
      after: {
        productId: "prod-1",
        missingItemId: "missing-1",
        linkedReportsCount: 2,
      },
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("rawName");
  });

  // El vínculo YA se persistió: un fallo posterior de auditoría no debe decirle
  // a gerencia que falló, o reintentaría sobre un grupo ya vinculado.
  it("reports success when auditing fails after the link was persisted", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);
    mocks.recordAudit.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(
      linkMissingReportToProductAction(PREV, linkFormData()),
    ).resolves.toMatchObject({ ok: true, missingItemId: "missing-1" });
  });

  it("revalidates both the review queue and the faltantes list", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);

    await linkMissingReportToProductAction(PREV, linkFormData());

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/revision-faltantes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
  });

  it("returns a generic error when the link itself fails", async () => {
    grant("ADMIN", ["canReviewMissingReports"]);
    mocks.linkReportToProduct.mockRejectedValueOnce(new Error("db down"));

    const result = await linkMissingReportToProductAction(PREV, linkFormData());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("No se pudo vincular el reporte. Intentá de nuevo.");
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
});
