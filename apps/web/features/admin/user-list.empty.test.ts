/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/user.actions", () => ({
  setUserActiveAction: vi.fn(),
  archiveUserAction: vi.fn(),
  unarchiveUserAction: vi.fn(),
}));

import { UserList } from "./user-list";
import type { UserFilters } from "./filters";

// --------------------------------------------------------------------------
// Una lista vacía tiene que decir POR QUÉ está vacía.
//
// "No hay usuarios archivados" cuando en realidad hay muchos y lo que no
// coincide es el filtro no es un mensaje incompleto: es una afirmación falsa.
// Quien la lee concluye que no hay a quién restaurar y se va.
// --------------------------------------------------------------------------

function renderEmpty(filters: UserFilters) {
  render(
    createElement(UserList, {
      items: [],
      nextCursor: null,
      filters,
      currentUserRole: "SUPERADMIN",
      currentUserId: "u1",
      showArchived: filters.archived,
    }),
  );
}

afterEach(cleanup);

describe("UserList · estados vacíos", () => {
  it("operativa sin filtros: no existe ningún usuario", () => {
    renderEmpty({ archived: false });

    expect(screen.getByText(/todavía no hay usuarios/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Limpiar filtros" })).toBeNull();
  });

  it("operativa con filtros: no repite la acción global de limpiar", () => {
    renderEmpty({ archived: false, q: "zzz" });

    expect(screen.getByText(/sin coincidencias/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Limpiar filtros" })).toBeNull();
  });

  it("archivados sin filtros: no existen archivados", () => {
    renderEmpty({ archived: true });

    expect(screen.getByText("No hay usuarios archivados.")).toBeTruthy();
  });

  // El LOW que este slice cierra: con filtros puestos, el mensaje NO puede
  // afirmar que no hay archivados.
  it("archivados con filtros: lo dice sin mentir", () => {
    renderEmpty({ archived: true, q: "zzz" });

    expect(
      screen.getByText("No hay usuarios archivados con estos filtros."),
    ).toBeTruthy();
    expect(screen.queryByText("No hay usuarios archivados.")).toBeNull();
  });

  // Limpiar y volver a operativos viven juntos en la barra global. El estado
  // vacío no repite ninguna de esas dos acciones.
  it("archivados con filtros: no repite las acciones de la barra", () => {
    renderEmpty({ archived: true, q: "zzz" });

    expect(screen.queryByRole("link", { name: "Limpiar filtros" })).toBeNull();
    expect(screen.queryByRole("link", { name: /usuarios operativos/i })).toBeNull();
  });

  it("un rol filtrado también cuenta como filtro activo", () => {
    renderEmpty({ archived: false, role: "BODEGA" });

    expect(screen.getByText(/sin coincidencias/i)).toBeTruthy();
  });
});
