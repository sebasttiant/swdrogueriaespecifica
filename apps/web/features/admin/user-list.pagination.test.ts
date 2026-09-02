/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Las acciones son Server Actions: se aíslan para poder montar la lista.
vi.mock("@/server/actions/user.actions", () => ({
  setUserActiveAction: vi.fn(),
  archiveUserAction: vi.fn(),
  unarchiveUserAction: vi.fn(),
}));

import { UserList } from "./user-list";
import type { UserFilters } from "./filters";
import type { UserListItem } from "@/server/repositories/user.repository";

// --------------------------------------------------------------------------
// El enlace de "Ver más" lo arma el COMPONENTE.
//
// Que `adminPageHref` esté probada por su cuenta no dice nada sobre si la
// lista la usa bien: el defecto que este slice corrige vivía justamente en el
// cableado, donde el href se escribía a mano como `/admin?cursor=…` y tiraba
// los filtros. Una llamada equivocada —pasarle `{}` en vez del cursor, o pasar
// otros filtros— compila perfecto. Por eso se verifica el href renderizado.
// --------------------------------------------------------------------------

const USUARIO: UserListItem = {
  id: "u1",
  name: "Ana Gómez",
  email: "ana@ejemplo.com",
  role: "OPERADOR",
  active: true,
  archivedAt: null,
  createdAt: new Date("2026-01-01T10:00:00Z"),
};

// Vista OPERATIVA: es donde el filtro de estado significa algo. Dentro de
// archivados no se aplica —todo archivado esta inactivo—, asi que combinarlos
// aca probaria una URL que el contrato no puede producir.
const FILTROS_VIGENTES: UserFilters = {
  q: "ana maria",
  role: "ADMIN",
  status: "activos",
  archived: false,
  cursor: "cursor-viejo",
};

function renderList(overrides: Partial<Parameters<typeof UserList>[0]> = {}) {
  render(
    createElement(UserList, {
      items: [USUARIO],
      nextCursor: "cursor-nuevo",
      filters: FILTROS_VIGENTES,
      currentUserRole: "SUPERADMIN",
      currentUserId: "otro",
      showArchived: true,
      ...overrides,
    }),
  );
  return screen.getByRole("link", { name: "Ver más" });
}

afterEach(cleanup);

describe("UserList · el enlace de 'Ver más'", () => {
  it("conserva la búsqueda y los tres filtros", () => {
    const href = renderList().getAttribute("href") ?? "";
    const params = new URLSearchParams(href.split("?")[1] ?? "");

    expect(params.get("q")).toBe("ana maria");
    expect(params.get("role")).toBe("ADMIN");
    expect(params.get("status")).toBe("activos");
  });

  // Y en la vista archivada, la vista misma viaja en el enlace.
  it("conserva la vista archivada al paginar", () => {
    render(
      createElement(UserList, {
        items: [USUARIO],
        nextCursor: "cursor-nuevo",
        filters: { q: "ana", archived: true, cursor: "cursor-viejo" },
        currentUserRole: "SUPERADMIN",
        currentUserId: "otro",
        showArchived: true,
      }),
    );
    const href = screen.getByRole("link", { name: "Ver más" }).getAttribute("href") ?? "";

    expect(href).toContain("archived=true");
    expect(href).toContain("q=ana");
    expect(href).toContain("cursor=cursor-nuevo");
  });

  // Lo único que cambia es el cursor. Con `adminPageHref(filters, {})` el
  // enlace saldría con el cursor VIEJO y "Ver más" devolvería la misma página.
  it("reemplaza el cursor por el de la página siguiente", () => {
    const params = new URLSearchParams(
      (renderList().getAttribute("href") ?? "").split("?")[1] ?? "",
    );

    expect(params.get("cursor")).toBe("cursor-nuevo");
  });

  // El defecto original: `/admin?cursor=…` y nada más.
  it("no pierde ningún filtro por el camino", () => {
    const href = renderList().getAttribute("href") ?? "";

    expect(href.startsWith("/admin?")).toBe(true);
    expect(href).not.toBe("/admin?cursor=cursor-nuevo");
  });

  it("sin filtros vigentes, el enlace lleva solo el cursor", () => {
    const href = renderList({
      filters: { archived: false },
    }).getAttribute("href");

    expect(href).toBe("/admin?cursor=cursor-nuevo");
  });

  it("sin página siguiente no se ofrece 'Ver más'", () => {
    render(
      createElement(UserList, {
        items: [USUARIO],
        nextCursor: null,
        filters: FILTROS_VIGENTES,
        currentUserRole: "SUPERADMIN",
        currentUserId: "otro",
        showArchived: true,
      }),
    );

    expect(screen.queryByRole("link", { name: "Ver más" })).toBeNull();
  });
});
