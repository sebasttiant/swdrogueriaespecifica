/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchLaboratoriesAction: vi.fn(),
  createLaboratoryAction: vi.fn(),
}));

vi.mock("@/server/actions/laboratory.actions", () => ({
  searchLaboratoriesAction: mocks.searchLaboratoriesAction,
  createLaboratoryAction: mocks.createLaboratoryAction,
}));

import { LaboratorySearch } from "./laboratory-search";

// --------------------------------------------------------------------------
// Lo que se ve y lo que se envía tienen que ser el MISMO dato.
//
// El defecto que motivó estas pruebas: el input visible no tenía atributo
// `name`, así que lo que la persona escribía no entraba en FormData. El hidden
// del nombre salía de `selected`, que solo se llena al clickear una sugerencia.
// Resultado: escribir "Genfar" y enviar mandaba el nombre VACÍO, y el servidor
// rechazaba con "Escribí el nombre del laboratorio" sobre un campo que la
// pantalla mostraba lleno.
//
// Las pruebas que existían no podían verlo: arman el FormData a mano
// (`data.set("requestedLaboratoryName", "LabTest")`), o sea que verificaban un
// payload que el formulario real nunca produce. Estas leen el FormData del
// FORMULARIO DEL DOM, que es donde el defecto vive.
// --------------------------------------------------------------------------

/** El formulario real, con el componente adentro. */
function renderInForm(props: Record<string, unknown> = {}) {
  const { container } = render(
    createElement(
      "form",
      { "data-testid": "form" },
      createElement(LaboratorySearch, {
        name: "requestedLaboratoryId",
        nameForLabel: "requestedLaboratoryName",
        ...props,
      }),
    ),
  );
  return container.querySelector("form") as HTMLFormElement;
}

/** Lo que el navegador enviaría de verdad. */
function payload(form: HTMLFormElement) {
  const data = new FormData(form);
  return {
    id: String(data.get("requestedLaboratoryId") ?? ""),
    name: String(data.get("requestedLaboratoryName") ?? ""),
  };
}

const input = () => screen.getByRole("searchbox");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchLaboratoriesAction.mockResolvedValue({
    ok: true,
    laboratories: [
      { id: "lab-genfar", name: "Genfar", searchKey: "genfar", needsReview: false },
    ],
  });
});

afterEach(cleanup);

// --------------------------------------------------------------------------
// CASO B — nombre escrito a mano, sin tocar la sugerencia.
//
// Es el flujo que el commit `8840787c` prometía habilitar ("typing a name and
// submitting is enough") y que en realidad rompió.
// --------------------------------------------------------------------------
describe("LaboratorySearch · el nombre escrito viaja en FormData", () => {
  it("envía lo que la persona escribió, sin seleccionar sugerencia", async () => {
    const user = userEvent.setup();
    const form = renderInForm();

    await user.type(input(), "Tecnoquimicas");

    expect(payload(form).name).toBe("Tecnoquimicas");
  });

  it("no inventa un ID para un nombre que nadie seleccionó", async () => {
    const user = userEvent.setup();
    const form = renderInForm();

    await user.type(input(), "Tecnoquimicas");

    expect(payload(form).id).toBe("");
  });

  it("recorta los espacios de los extremos", async () => {
    const user = userEvent.setup();
    const form = renderInForm();

    await user.type(input(), "  Genfar  ");

    expect(payload(form).name).toBe("Genfar");
  });
});

// --------------------------------------------------------------------------
// CASO seleccionar — ID y nombre, los dos, y coherentes entre sí.
// --------------------------------------------------------------------------
describe("LaboratorySearch · sugerencia seleccionada", () => {
  it("envía el ID y el nombre de la sugerencia", async () => {
    const user = userEvent.setup();
    const form = renderInForm();

    await user.type(input(), "Genf");
    await waitFor(() => expect(screen.getByText("Genfar")).toBeDefined());
    await user.click(screen.getByText("Genfar"));

    expect(payload(form)).toEqual({ id: "lab-genfar", name: "Genfar" });
  });
});

// --------------------------------------------------------------------------
// CASO D — el ID no puede sobrevivir a un cambio de texto.
//
// Un ID identifica a UN laboratorio concreto. Si la persona seleccionó Genfar y
// después escribió Bayer, mandar el ID de Genfar con el nombre Bayer haría que
// el pendiente diga una cosa y apunte a otra. Y como el ID gana sobre el
// nombre en la resolución, el cliente terminaría con el laboratorio equivocado
// sin que nada lo delate.
// --------------------------------------------------------------------------
describe("LaboratorySearch · el texto cambia después de seleccionar", () => {
  it("suelta el ID cuando el texto deja de ser el del laboratorio elegido", async () => {
    const user = userEvent.setup();
    const form = renderInForm();

    await user.type(input(), "Genf");
    await waitFor(() => expect(screen.getByText("Genfar")).toBeDefined());
    await user.click(screen.getByText("Genfar"));
    expect(payload(form).id).toBe("lab-genfar");

    await user.clear(input());
    await user.type(input(), "Bayer");

    expect(payload(form)).toEqual({ id: "", name: "Bayer" });
  });

  it("NUNCA envía el ID de un laboratorio con el nombre de otro", async () => {
    const user = userEvent.setup();
    const form = renderInForm();

    await user.type(input(), "Genf");
    await waitFor(() => expect(screen.getByText("Genfar")).toBeDefined());
    await user.click(screen.getByText("Genfar"));

    // Editar sin borrar: se le agrega texto al nombre elegido.
    await user.type(input(), " Chile");

    const enviado = payload(form);
    expect(enviado.name).toBe("Genfar Chile");
    expect(enviado.id).toBe("");
  });
});

// --------------------------------------------------------------------------
// CASO C — sin laboratorio, el servidor tiene que poder rechazar.
// --------------------------------------------------------------------------
describe("LaboratorySearch · sin laboratorio", () => {
  it("manda ambos campos vacíos cuando no se escribió nada", () => {
    const form = renderInForm();

    expect(payload(form)).toEqual({ id: "", name: "" });
  });

  it("vacía los dos campos cuando se borra el texto", async () => {
    const user = userEvent.setup();
    const form = renderInForm();

    await user.type(input(), "Genf");
    await waitFor(() => expect(screen.getByText("Genfar")).toBeDefined());
    await user.click(screen.getByText("Genfar"));

    await user.clear(input());

    expect(payload(form)).toEqual({ id: "", name: "" });
  });

  it("un texto de solo espacios no cuenta como laboratorio", async () => {
    const user = userEvent.setup();
    const form = renderInForm();

    await user.type(input(), "   ");

    expect(payload(form).name).toBe("");
  });
});

// --------------------------------------------------------------------------
// CASO E — reintento después de un rechazo.
//
// El formulario vuelve con lo que la persona había cargado. Si eso no llegara
// al FormData, el reintento fallaría con el mismo error sobre un campo que se
// ve completo, y la persona no tendría forma de salir del bucle.
// --------------------------------------------------------------------------
describe("LaboratorySearch · reintento tras un rechazo", () => {
  it("conserva la selección previa en el payload", () => {
    const form = renderInForm({
      defaultSelectedId: "lab-genfar",
      defaultSelectedName: "Genfar",
    });

    expect(payload(form)).toEqual({ id: "lab-genfar", name: "Genfar" });
  });

  it("conserva un nombre previo escrito a mano, sin ID", () => {
    const form = renderInForm({ defaultSelectedName: "Tecnoquimicas" });

    expect(payload(form)).toEqual({ id: "", name: "Tecnoquimicas" });
  });

  it("permite corregir el laboratorio y reenviar", async () => {
    const user = userEvent.setup();
    const form = renderInForm({ defaultSelectedName: "Tecnoquimicaz" });

    await user.clear(input());
    await user.type(input(), "Tecnoquimicas");

    expect(payload(form).name).toBe("Tecnoquimicas");
  });
});

// --------------------------------------------------------------------------
// CASO F — lo visible y lo enviado no pueden divergir.
//
// Es el invariante del que salían todos los demás casos: si el valor mostrado
// y el valor enviado tienen fuentes distintas, tarde o temprano se separan.
// --------------------------------------------------------------------------
describe("LaboratorySearch · invariante", () => {
  it("el nombre enviado es siempre el texto visible, recortado", async () => {
    const user = userEvent.setup();
    const form = renderInForm();

    for (const texto of ["G", "Ge", "Genfar", "Genfar S.A."]) {
      await user.clear(input());
      await user.type(input(), texto);
      expect(payload(form).name).toBe(texto.trim());
      expect((input() as HTMLInputElement).value).toBe(texto);
    }
  });
});
