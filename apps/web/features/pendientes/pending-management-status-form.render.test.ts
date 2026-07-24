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

describe("PendingManagementStatusForm", () => {
  it("offers the four management options and carries the pending id", () => {
    const html = render();

    expect(html).toContain('name="status"');
    expect(html).toContain('name="id"');
    expect(html).toContain('value="pend-1"');
    expect(html).toContain("Solicitado");
    expect(html).toContain("En búsqueda");
    expect(html).toContain("Cotizando");
    expect(html).toContain("Agotado");
    expect(html).toContain("Aplicar");
  });

  // PENDIENTE no es un estado de gestión: el selector arranca en el primero.
  it("defaults to the first option when the pending has no management status yet", () => {
    const html = render("PENDIENTE");

    expect(html).toMatch(/value="SOLICITADO"[^>]*selected/);
  });

  it("preselects the current status when it is already a management status", () => {
    const html = render("AGOTADO");

    expect(html).toMatch(/value="AGOTADO"[^>]*selected/);
  });

  it("surfaces the rejection returned by the server action", () => {
    const message = "No se pudo actualizar el estado: el pendiente ya no admite cambios de gestión.";
    mockActionState({ error: message, ok: false });

    const html = render();

    expect(html).toContain('role="alert"');
    expect(html).toContain(message);
  });

  it("disables the select and button while the action is in flight", () => {
    mockActionState(IDLE, true);

    const html = render();

    expect(html).toMatch(/<select[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
