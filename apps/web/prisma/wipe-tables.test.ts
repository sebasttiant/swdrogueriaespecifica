import { describe, expect, it } from "vitest";

import { tablesToTruncate, WIPE_PROTECTED_TABLES } from "./wipe-tables";

const ALL_TABLES = [
  "users",
  "_prisma_migrations",
  "inventory_cutovers",
  "products",
  "laboratories",
  "suppliers",
  "product_suppliers",
  "product_batches",
  "pendings",
  "pending_deliveries",
  "missing_items",
  "inventory_entries",
  "audit_logs",
  "missing_reports",
];

describe("tablesToTruncate", () => {
  // Invariante de seguridad: pase lo que pase, la tabla de usuarios NUNCA se
  // trunca. Este test es la red que impide un blanqueo que deje sin acceso.
  it("never includes the users table", () => {
    expect(tablesToTruncate(ALL_TABLES)).not.toContain("users");
  });

  it("never includes the prisma migrations table", () => {
    expect(tablesToTruncate(ALL_TABLES)).not.toContain("_prisma_migrations");
  });

  it("never includes the inventory cutover marker", () => {
    expect(tablesToTruncate(ALL_TABLES)).not.toContain("inventory_cutovers");
  });

  it("keeps every protected table out even if listed first, last or duplicated", () => {
    const noisy = ["users", ...ALL_TABLES, "inventory_cutovers", "users"];
    for (const protectedTable of WIPE_PROTECTED_TABLES) {
      expect(tablesToTruncate(noisy)).not.toContain(protectedTable);
    }
  });

  it("returns every operational and catalog table", () => {
    expect(tablesToTruncate(ALL_TABLES)).toEqual([
      "products",
      "laboratories",
      "suppliers",
      "product_suppliers",
      "product_batches",
      "pendings",
      "pending_deliveries",
      "missing_items",
      "inventory_entries",
      "audit_logs",
      "missing_reports",
    ]);
  });

  it("returns nothing when there is nothing but protected tables", () => {
    expect(tablesToTruncate(WIPE_PROTECTED_TABLES)).toEqual([]);
  });
});
