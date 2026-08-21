/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fixOrionCodeAction: vi.fn() }));

vi.mock("@/server/actions/sku.actions", () => ({
  fixOrionCodeAction: mocks.fixOrionCodeAction,
}));

import { OrionFixForm } from "./orion-fix-form";

const PROPS = {
  productId: "prod-17",
  currentOrionCode: "ORION-OLD",
  identityVersion: 8,
} as const;

async function openForm() {
  const user = userEvent.setup();
  const rendered = render(createElement(OrionFixForm, PROPS));
  await user.click(screen.getByRole("button", { name: "Corregir el código" }));
  return { user, ...rendered };
}

function submittedFormData(): FormData {
  return mocks.fixOrionCodeAction.mock.calls.at(-1)?.[1] as FormData;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("OrionFixForm · corrección operativa", () => {
  it("abre el formulario con código anterior, identidad y control de envío", async () => {
    const { container } = await openForm();

    expect(screen.getByRole("textbox", { name: "Código correcto de Orion" })).toBeTruthy();
    expect(screen.getByText("ORION-OLD")).toBeTruthy();
    expect(container.querySelector('input[name="productId"]')?.getAttribute("value")).toBe(
      "prod-17",
    );
    expect(
      container.querySelector('input[name="expectedVersion"]')?.getAttribute("value"),
    ).toBe("8");
    expect(screen.getByRole("button", { name: "Guardar" })).toBeTruthy();
  });

  it("envía exactamente el código escrito y la identidad mostrada", async () => {
    mocks.fixOrionCodeAction.mockResolvedValue({ error: null, ok: true });
    const { user } = await openForm();

    await user.type(
      screen.getByRole("textbox", { name: "Código correcto de Orion" }),
      "ORION-NEW",
    );
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(mocks.fixOrionCodeAction).toHaveBeenCalledOnce());
    expect(submittedFormData().get("orionCode")).toBe("ORION-NEW");
    expect(submittedFormData().get("productId")).toBe("prod-17");
    expect(submittedFormData().get("expectedVersion")).toBe("8");
  });

  it("conserva el código escrito y muestra el error cuando autorización rechaza", async () => {
    mocks.fixOrionCodeAction.mockResolvedValue({
      error: "Tu sesión venció. Iniciá sesión de nuevo y volvé acá.",
      ok: false,
    });
    const { user } = await openForm();
    const input = screen.getByRole("textbox", {
      name: "Código correcto de Orion",
    }) as HTMLInputElement;

    await user.type(input, "ORION-RETRY");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/sesión venció/i);
    expect(input.value).toBe("ORION-RETRY");
  });

  it("confirma el éxito", async () => {
    mocks.fixOrionCodeAction.mockResolvedValue({ error: null, ok: true });
    const { user } = await openForm();

    await user.type(
      screen.getByRole("textbox", { name: "Código correcto de Orion" }),
      "ORION-NEW",
    );
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect((await screen.findByRole("status")).textContent).toContain("Código corregido.");
  });
});
