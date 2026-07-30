import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: vi.fn().mockResolvedValue({ user: { role: "ADMIN" } }),
}));
vi.mock("@/lib/auth/permissions", () => ({ can: vi.fn().mockReturnValue(true) }));
vi.mock("@/server/services/product.service", () => ({
  getProducts: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock("@/server/services/pending.service", () => ({
  getPendings: vi.fn().mockResolvedValue({ items: [], nextCursor: "next/cursor" }),
  getUsedZones: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/app/_components/app-shell/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/app/_components/ui/card", () => ({ Card: ({ children }: { children: unknown }) => children, CardTitle: ({ children }: { children: unknown }) => children }));
vi.mock("@/features/pendientes/pending-form", () => ({ PendingForm: () => null }));
vi.mock("@/features/pendientes/pending-list", () => ({ PendingList: () => null }));
vi.mock("@/features/pendientes/pending-compact-list", () => ({
  PendingCompactList: ({ pageHref }: { pageHref: (cursor: string) => string }) =>
    createElement("a", { href: pageHref("next/cursor") }, "Ver más"),
}));

import PendientesPage from "./page";

describe("PendientesPage · pagination href", () => {
  it("preserves history and lista while encoding the next cursor", async () => {
    const page = await PendientesPage({
      searchParams: Promise.resolve({ scope: "history", view: "lista", cursor: "current" }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('href="/pendientes?cursor=next%2Fcursor&amp;view=lista&amp;scope=history"');
  });
});
