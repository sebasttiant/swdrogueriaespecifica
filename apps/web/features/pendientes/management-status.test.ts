import { describe, expect, it } from "vitest";

import {
  MANAGEMENT_STATUSES,
  canSetManagementStatus,
  isManagementStatus,
} from "./management-status";

describe("MANAGEMENT_STATUSES", () => {
  it("are the four terms gerencia/compras uses, in workflow order", () => {
    expect(MANAGEMENT_STATUSES).toEqual([
      "SOLICITADO",
      "BUSQUEDA",
      "COTIZANDO",
      "AGOTADO",
    ]);
  });
});

describe("isManagementStatus", () => {
  it("accepts every management status", () => {
    for (const status of MANAGEMENT_STATUSES) {
      expect(isManagementStatus(status)).toBe(true);
    }
  });

  it("rejects lifecycle statuses that are not management-set", () => {
    expect(isManagementStatus("PENDIENTE")).toBe(false);
    expect(isManagementStatus("PARCIAL")).toBe(false);
    expect(isManagementStatus("ENTREGADO")).toBe(false);
    expect(isManagementStatus("CANCELADO")).toBe(false);
  });

  it("rejects non-string / unknown input without throwing", () => {
    expect(isManagementStatus(undefined)).toBe(false);
    expect(isManagementStatus(null)).toBe(false);
    expect(isManagementStatus(42)).toBe(false);
    expect(isManagementStatus("solicitado")).toBe(false);
  });
});

describe("canSetManagementStatus", () => {
  // Abierto y sin entrega en curso: gerencia todavía puede gestionarlo.
  it("allows setting from PENDIENTE and from any management status", () => {
    expect(canSetManagementStatus("PENDIENTE")).toBe(true);
    expect(canSetManagementStatus("SOLICITADO")).toBe(true);
    expect(canSetManagementStatus("BUSQUEDA")).toBe(true);
    expect(canSetManagementStatus("COTIZANDO")).toBe(true);
    expect(canSetManagementStatus("AGOTADO")).toBe(true);
  });

  // PARCIAL ya tiene una entrega en curso; ENTREGADO/CANCELADO son terminales.
  it("blocks setting once the pending entered delivery or a terminal state", () => {
    expect(canSetManagementStatus("PARCIAL")).toBe(false);
    expect(canSetManagementStatus("ENTREGADO")).toBe(false);
    expect(canSetManagementStatus("CANCELADO")).toBe(false);
  });
});
