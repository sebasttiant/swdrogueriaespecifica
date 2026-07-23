import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getMissingReportQueue: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
}));
vi.mock("@/server/services/missing-report.service", () => ({
  getMissingReportQueue: mocks.getMissingReportQueue,
}));

import { MAX_REVIEW_QUEUE_PAGE } from "@/features/faltantes/report-queue-paging";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";

import RevisionFaltantesPage from "./page";

function searchParams(params: { page?: string } = {}) {
  return Promise.resolve(params);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCapability.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
  mocks.getMissingReportQueue.mockResolvedValue({ groups: [], hasMore: false, page: 1 });
});

describe("RevisionFaltantesPage · authorization", () => {
  it("guards with canReviewMissingReports", async () => {
    await RevisionFaltantesPage({ searchParams: searchParams() });

    expect(mocks.requireCapability).toHaveBeenCalledWith("canReviewMissingReports");
  });

  // El orden importa: sin esto, mover el guard después del fetch expondría la
  // cola a un rol sin permiso durante el tiempo que tarde la consulta.
  it("runs the guard BEFORE touching the queue", async () => {
    const order: string[] = [];
    mocks.requireCapability.mockImplementation(async () => {
      order.push("guard");
      return { user: { id: "admin-1", role: "ADMIN" } };
    });
    mocks.getMissingReportQueue.mockImplementation(async () => {
      order.push("query");
      return { groups: [], hasMore: false, page: 1 };
    });

    await RevisionFaltantesPage({ searchParams: searchParams() });

    expect(order).toEqual(["guard", "query"]);
  });

  it("does not query the queue when the guard rejects", async () => {
    mocks.requireCapability.mockRejectedValue(new Error("REDIRECT:/dashboard"));

    await expect(
      RevisionFaltantesPage({ searchParams: searchParams() }),
    ).rejects.toThrow("REDIRECT:/dashboard");
    expect(mocks.getMissingReportQueue).not.toHaveBeenCalled();
  });
});

describe("RevisionFaltantesPage · page param", () => {
  it("defaults to the first page and the project page size", async () => {
    await RevisionFaltantesPage({ searchParams: searchParams() });

    expect(mocks.getMissingReportQueue).toHaveBeenCalledWith({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it("forwards a valid page number", async () => {
    await RevisionFaltantesPage({ searchParams: searchParams({ page: "4" }) });

    expect(mocks.getMissingReportQueue).toHaveBeenCalledWith({
      page: 4,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  // El param crudo NUNCA llega al service: pasa siempre por el parser, que lo
  // sanea. Sin esto, un `?page=-5` o `?page=abc` viajaría hasta la consulta.
  it("never passes the raw param through: junk and negatives are sanitized", async () => {
    for (const raw of ["abc", "-5", "0", "NaN"]) {
      mocks.getMissingReportQueue.mockClear();
      await RevisionFaltantesPage({ searchParams: searchParams({ page: raw }) });

      expect(mocks.getMissingReportQueue).toHaveBeenCalledWith({
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      });
    }
  });

  it("caps an absurd page instead of forwarding a huge offset", async () => {
    await RevisionFaltantesPage({
      searchParams: searchParams({ page: "999999999999" }),
    });

    expect(mocks.getMissingReportQueue).toHaveBeenCalledWith({
      page: MAX_REVIEW_QUEUE_PAGE,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });
});
