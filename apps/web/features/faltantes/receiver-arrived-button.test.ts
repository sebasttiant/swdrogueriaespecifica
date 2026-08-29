/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  markMissingItemArrivedAction: vi.fn(),
}));

vi.mock("@/server/actions/missing-receiver.actions", () => ({
  markMissingItemArrivedAction: mocks.markMissingItemArrivedAction,
}));

import { ReceiverArrivedButton } from "./receiver-arrived-button";

// --------------------------------------------------------------------------
// "Ya llegó": el gesto que hoy NO existe y corta la cadena entera.
//
// La acción del servidor está escrita, probada y auditada desde H2, pero ningún
// componente la importa. La columna de acción de "Ya pedidos" dice "Esperando
// que llegue" y ahí muere: nada mueve un faltante de PEDIDO a EN_BODEGA, así
// que la pestaña "En bodega" está siempre vacía y el botón "Registrar entrada"
// —que solo se pinta en esa pestaña— es inalcanzable.
//
// Resultado operativo: bodega recibe la caja y no tiene dónde decirlo. El
// pendiente del vendedor queda esperando una mercadería que ya está en el
// local.
// --------------------------------------------------------------------------

const montar = (props: { missingItemId?: string; productName?: string } = {}) =>
  render(
    createElement(ReceiverArrivedButton, {
      missingItemId: props.missingItemId ?? "mi-1",
      productName: props.productName ?? "Vitamina D",
    }),
  );

const boton = () => screen.getByRole("button", { name: /vitamina d/i });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.markMissingItemArrivedAction.mockResolvedValue({ error: null, ok: true });
});

afterEach(cleanup);

describe("botón 'Ya llegó'", () => {
  it("existe y se puede tocar", () => {
    montar();

    expect(boton()).toBeDefined();
  });

  // Con decenas de filas, un "Ya llegó" a secas no dice cuál se está marcando.
  it("nombra el producto en el rótulo accesible", () => {
    montar({ productName: "Crema Ponds" });

    expect(
      screen.getByRole("button", { name: /crema ponds/i }),
    ).toBeDefined();
  });

  it("envía el id del faltante al servidor", async () => {
    const user = userEvent.setup();
    montar({ missingItemId: "mi-42" });

    await user.click(boton());

    const formData = mocks.markMissingItemArrivedAction.mock.calls[0]?.[1] as FormData;
    expect(formData.get("missingItemId")).toBe("mi-42");
  });

  // El actor sale de la sesión, nunca del formulario: firmar la recepción a
  // nombre de otro rompería lo único que ese registro conserva.
  it("NO manda quién recibió: eso lo decide la sesión", async () => {
    const user = userEvent.setup();
    montar();

    await user.click(boton());

    const formData = mocks.markMissingItemArrivedAction.mock.calls[0]?.[1] as FormData;
    expect(formData.get("arrivedById")).toBeNull();
  });

  // Dos personas descargando el mismo pedido tocan la misma fila. El servidor
  // responde con un compare-and-set que no pisa nada; la pantalla tiene que
  // decirlo en vez de simular que funcionó.
  it("muestra el conflicto cuando la fila ya no estaba esperando", async () => {
    const user = userEvent.setup();
    mocks.markMissingItemArrivedAction.mockResolvedValue({
      error: "Ese faltante ya no está esperando: puede que alguien lo marcara antes. Actualizá la lista.",
      ok: false,
    });
    montar();

    await user.click(boton());

    expect((await screen.findByRole("alert")).textContent).toContain(
      "ya no está esperando",
    );
  });

  it("no muestra alerta cuando la recepción se registró", async () => {
    const user = userEvent.setup();
    montar();

    await user.click(boton());

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
