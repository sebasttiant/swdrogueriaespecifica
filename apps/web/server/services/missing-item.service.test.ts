import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo } = vi.hoisted(() => ({
  repo: {
    confirmMissingItem: vi.fn(),
    countOpenMissingItems: vi.fn(),
    findMissingItemById: vi.fn(),
    listMissingItems: vi.fn(),
  },
}));

vi.mock("@/server/repositories/missing-item.repository", () => repo);

import { confirmMissingItemOk } from "./missing-item.service";

beforeEach(() => vi.clearAllMocks());

function missing(overrides = {}) {
  return {
    id: "missing-1",
    status: "FALTANTE",
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    ...overrides,
  };
}

describe("confirmMissingItemOk", () => {
  it("confirms an active missing item with the management user id", async () => {
    const confirmedAt = new Date("2026-07-02T20:00:00.000Z");
    repo.findMissingItemById.mockResolvedValue(missing());
    repo.confirmMissingItem.mockResolvedValue(
      missing({ confirmedAt, confirmedById: "admin-1" }),
    );

    const result = await confirmMissingItemOk({
      id: "missing-1",
      confirmedById: "admin-1",
      confirmedAt,
    });

    expect(result.changed).toBe(true);
    expect(repo.confirmMissingItem).toHaveBeenCalledWith({
      id: "missing-1",
      confirmedById: "admin-1",
      confirmedAt,
      note: undefined,
    });
  });

  it("is safe for already-confirmed and closed inventory statuses", async () => {
    const existingConfirmedAt = new Date("2026-07-01T10:00:00.000Z");
    repo.findMissingItemById.mockResolvedValueOnce(
      missing({ confirmedAt: existingConfirmedAt, confirmedById: "older" }),
    );
    await expect(
      confirmMissingItemOk({ id: "missing-1", confirmedById: "admin-1" }),
    ).resolves.toEqual({
      item: expect.objectContaining({ confirmedAt: existingConfirmedAt }),
      changed: false,
    });

    repo.findMissingItemById.mockResolvedValueOnce(missing({ status: "RECIBIDO" }));
    await expect(
      confirmMissingItemOk({ id: "missing-1", confirmedById: "admin-1" }),
    ).resolves.toEqual({
      item: expect.objectContaining({ status: "RECIBIDO" }),
      changed: false,
    });
    expect(repo.confirmMissingItem).toHaveBeenCalledTimes(0);
  });
});
