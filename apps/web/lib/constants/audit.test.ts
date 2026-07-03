import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_MODULES } from "./audit";

describe("constantes de auditoría", () => {
  it("expone acciones canónicas con namespace por punto", () => {
    expect(AUDIT_ACTIONS.LOGIN_FAILED).toBe("auth.login.failed");
    expect(AUDIT_ACTIONS.MISSING_AUTO_CREATE).toBe("missing.auto.create");
    expect(AUDIT_ACTIONS.MISSING_CONFIRM_OK).toBe("missing.confirm.ok");
  });

  it("expone los módulos del sistema", () => {
    expect(AUDIT_MODULES.AUDITORIA).toBe("auditoria");
    expect(Object.values(AUDIT_MODULES)).toContain("entradas");
  });
});
