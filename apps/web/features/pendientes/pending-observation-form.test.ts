/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/server/actions/pending.actions", () => ({
  updatePendingObservationAction: vi.fn(),
}));
import { updatePendingObservationAction } from "@/server/actions/pending.actions";
import {
  PendingObservationForm,
  PendingObservationView,
} from "./pending-observation-form";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function mount(overrides: Partial<Parameters<typeof PendingObservationForm>[0]> = {}) {
  return render(
    createElement(PendingObservationForm, {
      pendingId: "pend-1",
      observation: null,
      version: 0,
      observedAt: null,
      observedByName: null,
      ...overrides,
    }),
  );
}

/** Lo que ve quien NO escribe: la vista sin hooks, montada sola. */
function mountView(observation: string | null) {
  return render(
    createElement(PendingObservationView, {
      observation,
      observedAt: null,
      observedByName: null,
    }),
  );
}

it("no ocupa lugar en una fila sin observación", () => {
  const { container } = mountView(null);
  expect(container.textContent).toBe("");
});

it("el vendedor LEE la observación sin recibir ningún control de escritura", () => {
  mountView("Llega el lunes");
  expect(screen.getByText(/Llega el lunes/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Guardar/ })).toBeNull();
  expect(screen.queryByText(/Agregar observación/)).toBeNull();
  expect(screen.queryByText(/Editar observación/)).toBeNull();
});

it("gerencia ve el gesto de alta cuando la fila todavía no tiene observación", () => {
  mount();
  expect(screen.getByText("Agregar observación")).toBeTruthy();
  // Sin bloque de lectura: no hay nada que leer todavía.
  expect(screen.queryByText(/^Gerencia:/)).toBeNull();
});

it("con observación cargada el gesto pasa a ser de edición", () => {
  mount({ observation: "Llega el lunes", version: 3 });
  expect(screen.getByText("Editar observación")).toBeTruthy();
});

it("envía el id y la versión que la pantalla tenía a la vista", async () => {
  const user = userEvent.setup();
  const { container } = mount({ observation: "Llega el lunes", version: 3 });
  await user.click(screen.getByText("Editar observación"));
  const form = container.querySelector("form")!;
  const data = new FormData(form);
  expect(data.get("id")).toBe("pend-1");
  expect(data.get("expectedVersion")).toBe("3");
  expect(data.get("observation")).toBe("Llega el lunes");
});

it("el borrador sobrevive a un guardado rechazado", async () => {
  vi.mocked(updatePendingObservationAction).mockResolvedValue({
    error: "Alguien más escribió una observación mientras editabas. Actualizá para verla.",
    ok: false,
  });
  const user = userEvent.setup();
  const { container } = mount();
  await user.click(screen.getByText("Agregar observación"));
  const textarea = screen.getByLabelText("Observación de gerencia");
  await user.type(textarea, "Confirmar con el proveedor");
  await user.click(screen.getByRole("button", { name: "Guardar" }));
  await screen.findByText(/Alguien más escribió/);
  const data = new FormData(container.querySelector("form")!);
  expect(data.get("observation")).toBe("Confirmar con el proveedor");
});

it("dice cómo se borra en vez de esconder un botón que no existe", async () => {
  const user = userEvent.setup();
  mount({ observation: "Llega el lunes", version: 1 });
  await user.click(screen.getByText("Editar observación"));
  await user.clear(screen.getByLabelText("Observación de gerencia"));
  expect(screen.getByText("Guardar vacío borra la observación")).toBeTruthy();
});

it("las dos representaciones de la misma fila no comparten el id del campo", async () => {
  const user = userEvent.setup();
  const { container } = render(
    createElement("div", null, [
      createElement(PendingObservationForm, {
        key: "card",
        pendingId: "pend-1",
        observation: null,
        version: 0,
        observedAt: null,
        observedByName: null,
        domSuffix: "card",
      }),
      createElement(PendingObservationForm, {
        key: "row",
        pendingId: "pend-1",
        observation: null,
        version: 0,
        observedAt: null,
        observedByName: null,
        domSuffix: "row",
      }),
    ]),
  );
  for (const summary of Array.from(container.querySelectorAll("summary"))) {
    await user.click(summary);
  }
  const ids = Array.from(container.querySelectorAll("textarea")).map((node) => node.id);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
});
