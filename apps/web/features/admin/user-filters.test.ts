/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UserFilters as UserFiltersBar } from "./user-filters";
import type { UserFilters } from "./filters";

// --------------------------------------------------------------------------
// La barra de filtros es un formulario GET.
//
// Sin JavaScript de por medio: el navegador arma la URL con los campos que
// tienen `name`, y esa URL es exactamente el contrato que el servidor ya sabe
// leer. Nada se filtra en el cliente y no hay una segunda interpretación de los
// parámetros.
//
// El `cursor` NO viaja: cambiar un filtro cambia el conjunto de resultados, y
// una posición dentro del conjunto anterior no significa nada en el nuevo.
// --------------------------------------------------------------------------

const SIN_FILTROS: UserFilters = { archived: false };

function renderBar(filters: UserFilters = SIN_FILTROS) {
  const { container } = render(
    createElement(UserFiltersBar, { filters, canSeeArchived: true }),
  );
  return container.querySelector("form") as HTMLFormElement;
}

afterEach(cleanup);

describe("UserFilters · el formulario", () => {
  it("es un GET hacia /admin", () => {
    const form = renderBar();

    expect(form.getAttribute("method")?.toLowerCase()).toBe("get");
    expect(form.getAttribute("action")).toBe("/admin");
  });

  it("ofrece búsqueda por nombre o correo, con label real", () => {
    renderBar();

    expect(screen.getByLabelText(/buscar/i)).toBeTruthy();
  });

  it("ofrece filtro por rol", () => {
    renderBar();

    expect(screen.getByLabelText("Rol")).toBeTruthy();
  });

  it("ofrece filtro por estado en la vista operativa", () => {
    renderBar();

    expect(screen.getByLabelText("Estado")).toBeTruthy();
  });

  // El cursor viaja en la URL, no en el formulario: si viajara, cambiar un
  // filtro conservaría una posición de la lista anterior.
  it("NO incluye el cursor", () => {
    const form = renderBar({ ...SIN_FILTROS, q: "ana", cursor: "c1" });

    expect(new FormData(form).get("cursor")).toBeNull();
    expect(form.querySelector('[name="cursor"]')).toBeNull();
  });
});

describe("UserFilters · precarga lo que ya está aplicado", () => {
  it("precarga la búsqueda", () => {
    renderBar({ ...SIN_FILTROS, q: "ana maria" });

    expect((screen.getByLabelText(/buscar/i) as HTMLInputElement).value).toBe("ana maria");
  });

  it("precarga el rol", () => {
    renderBar({ ...SIN_FILTROS, role: "BODEGA" });

    expect((screen.getByLabelText("Rol") as HTMLSelectElement).value).toBe("BODEGA");
  });

  it("precarga el estado", () => {
    renderBar({ ...SIN_FILTROS, status: "inactivos" });

    expect((screen.getByLabelText("Estado") as HTMLSelectElement).value).toBe("inactivos");
  });
});

describe("UserFilters · activos y archivados", () => {
  it("dentro de archivados no se ofrece filtrar por estado", () => {
    renderBar({ archived: true });

    // Todo archivado está inactivo: el control prometería resultados que no
    // pueden existir.
    expect(screen.queryByLabelText("Estado")).toBeNull();
  });

  it("dentro de archivados la vista queda declarada en el formulario", () => {
    const form = renderBar({ archived: true });

    expect(new FormData(form).get("archived")).toBe("true");
  });

  it("en la vista operativa no se declara archived", () => {
    const form = renderBar();

    expect(new FormData(form).get("archived")).toBeNull();
  });

  it("quien no puede ver archivados no recibe el enlace", () => {
    render(
      createElement(UserFiltersBar, { filters: SIN_FILTROS, canSeeArchived: false }),
    );

    expect(screen.queryByRole("link", { name: /archivad/i })).toBeNull();
  });

  it("quien sí puede, tiene el enlace a archivados sin cursor", () => {
    render(
      createElement(UserFiltersBar, {
        filters: { ...SIN_FILTROS, q: "ana", cursor: "viejo" },
        canSeeArchived: true,
      }),
    );

    const href = screen.getByRole("link", { name: /archivad/i }).getAttribute("href") ?? "";
    expect(href).toContain("archived=true");
    expect(href).toContain("q=ana");
    expect(href).not.toContain("cursor");
  });
});

describe("UserFilters · limpiar", () => {
  it("con filtros activos ofrece limpiarlos, y apunta a /admin", () => {
    renderBar({ ...SIN_FILTROS, q: "ana", role: "ADMIN" });

    expect(screen.getByRole("link", { name: "Limpiar filtros" }).getAttribute("href")).toBe("/admin");
  });

  it("dentro de archivados, limpiar conserva la vista archivada", () => {
    renderBar({ archived: true, q: "ana" });

    expect(
      screen.getByRole("link", { name: "Limpiar filtros" }).getAttribute("href"),
    ).toBe("/admin?archived=true");
  });

  it("sin filtros activos no se ofrece limpiar", () => {
    renderBar();

    expect(screen.queryByRole("link", { name: "Limpiar filtros" })).toBeNull();
  });
});
