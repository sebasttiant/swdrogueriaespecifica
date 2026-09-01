/** @vitest-environment jsdom */

import { createElement, Fragment } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/user.actions", () => ({
  createUserAction: vi.fn(),
}));

const hookState = vi.hoisted(() => ({
  value: { error: null as string | null, ok: false },
}));

vi.mock("@/lib/hooks/use-action-state", () => ({
  useActionState: () => [hookState.value, vi.fn(), false],
}));

import { UserCreatePanel } from "./user-create-panel";
import { UserFilters } from "./user-filters";

// --------------------------------------------------------------------------
// El alta no puede tapar la lista.
//
// A 375 px el formulario desplegado ocupaba la primera pantalla entera: quien
// entraba a buscar a una persona tenía que atravesar todo el alta antes de ver
// a nadie. Ahora es una acción que revela el formulario.
//
// Se usa `<details>`/`<summary>`, que es HTML: se abre con Enter o Espacio, el
// lector de pantalla anuncia el estado, y cerrado el contenido no se muestra ni
// ocupa lugar. Nada de esconderlo con CSS dejándolo igual de presente.
//
// LO QUE SE AFIRMA ACÁ es el estado `open`, que es la semántica del elemento.
// jsdom no implementa NI el ocultamiento visual de `<details>` —renderiza el
// contenido igual— NI el toggle por teclado del `<summary>`. Afirmar esas dos
// cosas acá daría pruebas que no pueden fallar por la razón correcta; las dos
// se comprueban en la revisión visual, con un navegador de verdad.
// --------------------------------------------------------------------------

function panel() {
  const { container, rerender } = render(
    createElement(UserCreatePanel, { actorRole: "SUPERADMIN" }),
  );
  return {
    detalle: container.querySelector("details") as HTMLDetailsElement,
    // El `<summary>`, no el botón de envío del formulario: los dos dicen
    // "Crear usuario" y solo uno es el que revela la sección.
    accion: container.querySelector("summary") as HTMLElement,
    rerender,
  };
}

afterEach(() => {
  hookState.value = { error: null, ok: false };
  cleanup();
});

describe("UserCreatePanel", () => {
  it("arranca cerrado: la lista es lo primero que se ve", () => {
    expect(panel().detalle.open).toBe(false);
  });

  it("ofrece una acción visible para crear usuario", () => {
    expect(panel().accion.textContent).toContain("Crear usuario");
  });

  it("al activarla, revela el formulario", async () => {
    const { detalle, accion } = panel();

    await userEvent.click(accion);

    expect(detalle.open).toBe(true);
    expect(screen.getByLabelText("Nombre")).toBeTruthy();
  });

  // La respuesta de la Server Action actualiza el formulario y refresca el árbol.
  // El `<details>` conserva su estado nativo, por lo que el error no queda oculto.
  it("si el alta falla, conserva el panel abierto y muestra el error", async () => {
    const { detalle, accion, rerender } = panel();
    await userEvent.click(accion);

    hookState.value = { error: "Ya existe un usuario con ese email.", ok: false };
    rerender(createElement(UserCreatePanel, { actorRole: "SUPERADMIN" }));

    expect(detalle.open).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "Ya existe un usuario con ese email.",
    );
  });

  it("todo estado de error fuerza el panel abierto", () => {
    hookState.value = { error: "Ya existe un usuario con ese email.", ok: false };

    const { detalle } = panel();

    expect(detalle.open).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "Ya existe un usuario con ese email.",
    );
  });

  it("el rol del alta tiene una identidad propia y conserva name=role", () => {
    const { container } = render(
      createElement(Fragment, null,
        createElement(UserFilters, {
          filters: { archived: false },
          canSeeArchived: true,
        }),
        createElement(UserCreatePanel, { actorRole: "SUPERADMIN" }),
      ),
    );

    const filterRole = container.querySelector(
      'form[method="get"] select[name="role"]',
    ) as HTMLSelectElement;
    const createRole = container.querySelector(
      'form:not([method="get"]) select[name="role"]',
    ) as HTMLSelectElement;
    const createLabel = Array.from(container.querySelectorAll("label")).find(
      (label) => label.textContent === "Rol" && label.htmlFor === createRole.id,
    );

    expect(createRole.name).toBe("role");
    expect(createRole.id).not.toBe(filterRole.id);
    expect(createLabel?.htmlFor).toBe(createRole.id);
  });

  it("la acción tiene altura táctil suficiente", () => {
    expect(panel().accion.className).toContain("min-h-11");
  });

  it("conserva los campos y validaciones del alta", async () => {
    const { accion } = panel();

    await userEvent.click(accion);

    expect(screen.getByLabelText("Nombre")).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText("Contraseña inicial")).toBeTruthy();
    expect(screen.getByLabelText("Rol")).toBeTruthy();
  });
});
