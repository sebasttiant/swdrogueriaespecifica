import { describe, expect, it } from "vitest";

import type { UserListItem } from "@/server/repositories/user.repository";

import { getAdminOverviewMetrics } from "./admin-overview";

function user(overrides: Partial<UserListItem>): UserListItem {
  return {
    id: "user-id",
    name: "User",
    email: "user@example.com",
    role: "OPERADOR",
    active: true,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("getAdminOverviewMetrics", () => {
  it("calcula métricas solo desde la lista cargada", () => {
    const metrics = getAdminOverviewMetrics([
      user({ id: "super", role: "SUPERADMIN" }),
      user({ id: "admin", role: "ADMIN", active: false }),
      user({ id: "supervisor", role: "SUPERVISOR" }),
      user({
        id: "archived",
        role: "OPERADOR",
        active: false,
        archivedAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    ]);

    expect(metrics).toEqual({
      totalVisible: 4,
      activeVisible: 2,
      archivedVisible: 1,
      roleCounts: {
        SUPERADMIN: 1,
        ADMIN: 1,
        SUPERVISOR: 1,
        OPERADOR: 1,
        BODEGA: 0,
      },
    });
  });
});
