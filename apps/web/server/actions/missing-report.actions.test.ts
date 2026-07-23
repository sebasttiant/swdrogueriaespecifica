import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  submitMissingReport: vi.fn(),
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
  return { ...actual, submitMissingReport: mocks.submitMissingReport };
});

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { MissingReportEmptyNameError } from "@/server/services/missing-report.service";
import { createMissingReportAction } from "./missing-report.actions";

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
      reporterId: "operador-1",
    });
    const arg = mocks.submitMissingReport.mock.calls[0]![0] as { reporterId: string };
    expect(arg.reporterId).not.toBe("attacker-999");
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
