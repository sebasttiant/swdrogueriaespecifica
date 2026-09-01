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

vi.mock("@/lib/hooks/use-action-state", () => ({
  useActionState: () => [{ error: null, ok: false }, vi.fn(), false],
}));

vi.mock("@/server/actions/entry.actions", () => ({
  createInventoryEntryAction: vi.fn(),
}));

import { EntryForm } from "./entry-form";

// --------------------------------------------------------------------------
// El laboratorio de lo que llegó tiene que VIAJAR en el formulario.
//
// El servidor ya lo espera: `entry.actions.ts` lee `receivedLaboratoryId` y
// `receivedLaboratoryName` del FormData, y el servicio resuelve el nombre,
// crea el laboratorio si es nuevo con clave idempotente, y bajo concurrencia
// bloquea el lote y compara la evidencia antes de escribir.
//
// Todo eso existe y NUNCA se ejecutaba, porque el formulario no tenía ningún
// campo con esos nombres: `formData.get(...)` devolvía `null` siempre.
//
// Es la misma forma del defecto del laboratorio en pendientes, dada vuelta:
// allá la acción no leía el campo, acá la pantalla no lo mandaba. Por eso la
// prueba arma el FormData desde el FORMULARIO DEL DOM y no a mano: un payload
// escrito a mano nunca habría visto el hueco.
// --------------------------------------------------------------------------

const PRODUCTO = {
  id: "prod-1",
  name: "Acetaminofén",
  code: "ACE-1",
  orionCode: "ORN-1",
  laboratoryName: "Genfar",
  unit: "caja",
  identityVersion: 0,
  catalogVersion: 0,
};

function montar() {
  const { container } = render(
    createElement(EntryForm, { products: [PRODUCTO] }),
  );
  return container.querySelector("form") as HTMLFormElement;
}

/** Lo que el navegador enviaría de verdad. */
function payload(form: HTMLFormElement) {
  const data = new FormData(form);
  return {
    id: String(data.get("receivedLaboratoryId") ?? ""),
    name: String(data.get("receivedLaboratoryName") ?? ""),
  };
}

const buscador = () => screen.getByRole("searchbox");

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

describe("registro de entrada · laboratorio de lo recibido", () => {
  it("el campo existe en el formulario", () => {
    montar();

    expect(buscador()).toBeDefined();
  });

  it("envía el nombre escrito a mano, sin elegir sugerencia", async () => {
    const user = userEvent.setup();
    const form = montar();

    await user.type(buscador(), "Tecnoquimicas");

    expect(payload(form).name).toBe("Tecnoquimicas");
  });

  // Un laboratorio que todavía no está en la lista es el caso NORMAL cuando
  // llega mercadería de un proveedor nuevo. El servicio lo crea con clave
  // idempotente; la pantalla solo tiene que dejar escribirlo.
  it("no inventa un ID para un laboratorio que nadie seleccionó", async () => {
    const user = userEvent.setup();
    const form = montar();

    await user.type(buscador(), "Tecnoquimicas");

    expect(payload(form).id).toBe("");
  });

  it("envía el ID cuando se elige uno de la lista", async () => {
    const user = userEvent.setup();
    const form = montar();

    await user.type(buscador(), "Genf");
    await waitFor(() => expect(screen.getByText("Genfar")).toBeDefined());
    await user.click(screen.getByText("Genfar"));

    expect(payload(form)).toEqual({ id: "lab-genfar", name: "Genfar" });
  });

  // El laboratorio es evidencia de lo que llegó, no un dato obligatorio: si el
  // remito no lo aclara, exigirlo frenaría una recepción real por un dato que
  // bodega no tiene.
  it("deja registrar la entrada sin laboratorio", () => {
    const form = montar();

    expect(payload(form)).toEqual({ id: "", name: "" });
  });
});
