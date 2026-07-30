import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/pending.actions", () => ({
  updatePendingManagementStatusAction: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PendingStatus } from "@/lib/generated/prisma/client";

import { PendingManagementStatusForm } from "./pending-management-status-form";

type ActionState = { error: string | null; ok: boolean };

const IDLE: ActionState = { error: null, ok: false };

function mockActionState(state: ActionState, isPending = false) {
  useActionStateMock.mockReturnValue([state, vi.fn(), isPending]);
}

function render(currentStatus: PendingStatus = "PENDIENTE"): string {
  return renderToStaticMarkup(
    createElement(PendingManagementStatusForm, { pendingId: "pend-1", currentStatus }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActionState(IDLE);
});

// --------------------------------------------------------------------------
// El control dejó de ser un `<select>` de cuatro opciones + "Aplicar". Ese
// diseño le preguntaba al gerente algo que ya había respondido —aparecía igual
// sobre un pendiente YA pedido— y costaba dos gestos para la acción que hace
// decenas de veces por día.
// --------------------------------------------------------------------------
describe("PendingManagementStatusForm · todavía por pedir", () => {
  it("ofrece los dos desenlaces reales a un toque, sin selector", () => {
    const html = render("PENDIENTE");

    expect(html).toContain("Ya lo pedí");
    expect(html).toContain("Agotado");
    // Un toque: sin lista desplegable y sin botón "Aplicar" que confirme.
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Aplicar");
  });

  it("cada botón lleva su estado y el id del pendiente", () => {
    const html = render("PENDIENTE");

    expect(html).toContain('name="id" value="pend-1"');
    expect(html).toContain('name="status" value="SOLICITADO"');
    expect(html).toContain('name="status" value="AGOTADO"');
  });

  // Los estados intermedios existen, pero no le roban lugar al camino diario.
  it("guarda los estados intermedios detrás de un gesto", () => {
    const html = render("PENDIENTE");

    expect(html).toContain("Otro estado");
    expect(html).toContain('name="status" value="BUSQUEDA"');
    expect(html).toContain('name="status" value="COTIZANDO"');
  });

  it("no ofrece marcar el estado en el que ya está", () => {
    const html = render("PENDIENTE");

    // PENDIENTE no es un estado de gestión: los cuatro siguen disponibles.
    expect(html).toContain('name="status" value="SOLICITADO"');
  });
});

// ESTO ES LO QUE PIDIÓ GERENCIA: "en ya pedido no debería salir todas las
// funciones... ya está pedido". Un pendiente resuelto informa su estado y se
// sale del paso.
describe("PendingManagementStatusForm · ya gestionado", () => {
  it("muestra el estado y NO vuelve a preguntar", () => {
    const html = render("SOLICITADO");

    expect(html).toContain("Solicitado");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Aplicar");
  });

  it("no vuelve a ofrecer el estado que ya tiene", () => {
    const html = render("SOLICITADO");

    expect(html).not.toContain('name="status" value="SOLICITADO"');
  });

  // Cambiar de opinión sigue siendo posible —se pidió y no llegó, se agota—,
  // pero detrás de un gesto explícito.
  it("deja cambiar de estado detrás de un gesto explícito", () => {
    const html = render("SOLICITADO");

    expect(html).toContain("cambiar");
    expect(html).toContain('name="status" value="AGOTADO"');
    expect(html).toContain('name="status" value="BUSQUEDA"');
  });

  it("informa el estado con su etiqueta en español, no el valor del enum", () => {
    expect(render("BUSQUEDA")).toContain("En búsqueda");
    expect(render("AGOTADO")).toContain("Agotado");
  });
});

describe("PendingManagementStatusForm · estado de la acción", () => {
  it("deshabilita los botones mientras la acción está en vuelo", () => {
    mockActionState(IDLE, true);

    expect(render("PENDIENTE")).toContain("disabled");
  });

  it("muestra el rechazo devuelto por la Server Action", () => {
    mockActionState({ error: "Este pendiente ya no admite gestión.", ok: false });

    const html = render("PENDIENTE");

    expect(html).toContain('role="alert"');
    expect(html).toContain("Este pendiente ya no admite gestión.");
  });
});
