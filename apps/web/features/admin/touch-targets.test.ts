/** @vitest-environment jsdom */

import { createElement, Fragment } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/user.actions", () => ({
  setUserActiveAction: vi.fn(),
  archiveUserAction: vi.fn(),
  unarchiveUserAction: vi.fn(),
}));

import { UserList } from "./user-list";
import { UserFilters as UserFiltersBar } from "./user-filters";
import type { UserListItem } from "@/server/repositories/user.repository";

// --------------------------------------------------------------------------
// Todo lo que se toca tiene que poder tocarse.
//
// Los enlaces de acción medían 21 px de alto: el proyecto documenta 44 px como
// mínimo cómodo para un dedo adulto, y esta pantalla se usa desde el teléfono.
// El área interactiva puede ser más alta que el texto; lo que no puede es ser
// más chica que el dedo.
//
// Se comprueba la clase de altura mínima, que es la garantía semántica estable
// del proyecto — no la cadena completa de clases, que cambia con cualquier
// retoque visual.
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

const ALTURA_TACTIL = "min-h-11";

afterEach(cleanup);

describe("Objetivos táctiles · lista", () => {
  function renderLista(extra: Partial<Parameters<typeof UserList>[0]> = {}) {
    render(
      createElement(UserList, {
        items: [USUARIO],
        nextCursor: "c1",
        filters: { archived: false },
        currentUserRole: "SUPERADMIN",
        currentUserId: "otro",
        showArchived: false,
        ...extra,
      }),
    );
  }

  it("los enlaces 'Editar' son tocables", () => {
    renderLista();

    for (const editar of screen.getAllByRole("link", { name: "Editar" })) {
      expect(editar.className).toContain(ALTURA_TACTIL);
      expect(editar.className).toContain("min-w-11");
    }
  });

  it("mantiene tarjetas hasta que la tabla tiene ancho útil suficiente", () => {
    const { container } = render(
      createElement(UserList, {
        items: [USUARIO],
        nextCursor: null,
        filters: { archived: false },
        currentUserRole: "SUPERADMIN",
        currentUserId: "otro",
        showArchived: false,
      }),
    );

    const table = container.querySelector("table");
    const cardList = container.querySelector(".min-\\[1400px\\]\\:hidden");

    expect(cardList).toBeTruthy();
    expect(table?.parentElement?.className).toContain("min-[1400px]:block");
  });

  it("el enlace de paginación es tocable", () => {
    renderLista();

    expect(
      screen.getByRole("link", { name: "Ver más" }).className,
    ).toContain(ALTURA_TACTIL);
  });

  it("la salida global de una lista vacía es tocable", () => {
    render(
      createElement(Fragment, null,
        createElement(UserFiltersBar, {
          filters: { archived: false, q: "zzz" },
          canSeeArchived: true,
        }),
        createElement(UserList, {
          items: [],
          nextCursor: null,
          filters: { archived: false, q: "zzz" },
          currentUserRole: "SUPERADMIN",
          currentUserId: "u1",
          showArchived: false,
        }),
      ),
    );

    expect(
      screen.getByRole("link", { name: "Limpiar filtros" }).className,
    ).toContain(ALTURA_TACTIL);
  });
});

describe("Objetivos táctiles · barra de filtros", () => {
  it("'Ver archivados' y 'Limpiar filtros' son tocables", () => {
    render(
      createElement(UserFiltersBar, {
        filters: { archived: false, q: "ana" },
        canSeeArchived: true,
      }),
    );

    expect(screen.getByRole("link", { name: /archivad/i }).className).toContain(ALTURA_TACTIL);
    expect(screen.getByRole("link", { name: "Limpiar filtros" }).className).toContain(ALTURA_TACTIL);
  });

  it("'Ver usuarios operativos' es tocable", () => {
    render(
      createElement(UserFiltersBar, {
        filters: { archived: true },
        canSeeArchived: true,
      }),
    );

    expect(
      screen.getByRole("link", { name: /usuarios operativos/i }).className,
    ).toContain(ALTURA_TACTIL);
  });
});

describe("Estados vacíos compuestos · sin duplicar salidas", () => {
  it("mantiene un solo limpiar filtros y la salida a usuarios operativos", () => {
    render(
      createElement(Fragment, null,
        createElement(UserFiltersBar, {
          filters: { archived: true, q: "zzz" },
          canSeeArchived: true,
        }),
        createElement(UserList, {
          items: [],
          nextCursor: null,
          filters: { archived: true, q: "zzz" },
          currentUserRole: "SUPERADMIN",
          currentUserId: "u1",
          showArchived: true,
        }),
      ),
    );

    expect(screen.getAllByRole("link", { name: "Limpiar filtros" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /usuarios operativos/i })).toBeTruthy();
  });

  it("en la vista operativa filtrada también muestra un solo limpiar", () => {
    render(
      createElement(Fragment, null,
        createElement(UserFiltersBar, {
          filters: { archived: false, q: "zzz" },
          canSeeArchived: true,
        }),
        createElement(UserList, {
          items: [],
          nextCursor: null,
          filters: { archived: false, q: "zzz" },
          currentUserRole: "SUPERADMIN",
          currentUserId: "u1",
          showArchived: false,
        }),
      ),
    );

    expect(screen.getAllByRole("link", { name: "Limpiar filtros" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Ver archivados" })).toBeTruthy();
  });
});
