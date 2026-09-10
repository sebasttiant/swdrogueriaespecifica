/** @vitest-environment jsdom */

import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingFormState } from "@/server/actions/pending.actions";

// --------------------------------------------------------------------------
// Clave de idempotencia del formulario de ENTREGA.
//
// A diferencia de `PendingForm` (que se remonta entero tras cada respuesta y
// por eso su `attemptKey` nace de nuevo solo), `PendingDeliverForm` vive
// montado en la fila del pendiente durante toda la sesión: el mismo
// componente sirve para la primera entrega parcial y para la siguiente. La
// clave tiene que sobrevivir un rechazo (mismo intento, se reintenta) y
// renovarse tras un éxito (una entrega parcial legítima posterior es un
// intento NUEVO, y reusar la clave la haría un replay silencioso).
// --------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({ deliverPendingAction: vi.fn() }));

vi.mock("@/server/actions/pending.actions", () => ({
  deliverPendingAction: mocks.deliverPendingAction,
}));

import { PendingDeliverForm } from "./pending-deliver-form";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hiddenKey(container: HTMLElement): string {
  const el = container.querySelector('input[name="idempotencyKey"]');
  if (!el) throw new Error("no hay input oculto idempotencyKey");
  return (el as HTMLInputElement).value;
}

async function settle() {
  await act(async () => {});
}

function renderForm() {
  return render(
    createElement(PendingDeliverForm, { pendingId: "pending-1", remaining: 6 }),
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("PendingDeliverForm · clave de idempotencia", () => {
  it("renderiza un input oculto idempotencyKey con forma de UUID v4", () => {
    const { container } = renderForm();

    expect(hiddenKey(container)).toMatch(UUID_PATTERN);
  });

  it("mantiene la MISMA clave cuando el servicio rechaza la entrega", async () => {
    mocks.deliverPendingAction.mockResolvedValue({
      error: "La cantidad supera lo que resta por entregar.",
      ok: false,
    } satisfies PendingFormState);
    const user = userEvent.setup();
    const { container } = renderForm();
    const before = hiddenKey(container);

    await user.click(screen.getByRole("button", { name: /entregar/i }));
    await settle();

    await screen.findByRole("alert");
    expect(hiddenKey(container)).toBe(before);
  });

  it("renueva la clave tras una entrega exitosa: la siguiente es un intento nuevo", async () => {
    mocks.deliverPendingAction.mockResolvedValue({
      error: null,
      ok: true,
    } satisfies PendingFormState);
    const user = userEvent.setup();
    const { container } = renderForm();
    const before = hiddenKey(container);

    await user.click(screen.getByRole("button", { name: /entregar/i }));
    await settle();

    const after = hiddenKey(container);
    expect(after).not.toBe(before);
    expect(after).toMatch(UUID_PATTERN);
  });
});
