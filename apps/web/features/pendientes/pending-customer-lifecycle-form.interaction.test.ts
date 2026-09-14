/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoicePendingAction: vi.fn() }));

vi.mock("@/server/actions/pending.actions", () => ({
  invoicePendingAction: mocks.invoicePendingAction,
}));

import { PendingCustomerLifecycleForm } from "./pending-customer-lifecycle-form";

// --------------------------------------------------------------------------
// U5 — facturar por encima de lo que tiene stock exige un SEGUNDO paso.
//
// Hasta lo facturable, el gesto es el de siempre: un toque. Por encima, el
// formulario no envía nada: muestra cuánto tiene stock y cuánto se facturaría
// sin él, y solo "Confirmar facturación sin stock" manda la marca. El servidor
// sigue siendo la fuente de verdad.
// --------------------------------------------------------------------------

type FormProps = {
  quantity?: number;
  invoicedQuantity?: number;
  invoiceableQuantity?: number;
};

function renderForm(props: FormProps = {}) {
  const user = userEvent.setup();
  const rendered = render(
    createElement(PendingCustomerLifecycleForm, {
      pendingId: "pend-9",
      customerStatus: "POR_CONTACTAR",
      quantity: props.quantity ?? 10,
      invoicedQuantity: props.invoicedQuantity ?? 0,
      invoiceableQuantity: props.invoiceableQuantity ?? 3,
    }),
  );
  return { user, ...rendered };
}

function quantityInput(): HTMLInputElement {
  return screen.getByRole("spinbutton", { name: "Cantidad a facturar" }) as HTMLInputElement;
}

function submittedFormData(): FormData {
  return mocks.invoicePendingAction.mock.calls.at(-1)?.[1] as FormData;
}

async function enterQuantity(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.clear(quantityInput());
  await user.type(quantityInput(), value);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoicePendingAction.mockResolvedValue({ error: null, ok: true });
});
afterEach(cleanup);

describe("PendingCustomerLifecycleForm · cantidad inicial", () => {
  it("precarga lo facturable, topa en el saldo y manda lo facturado que vio", () => {
    const { container } = renderForm({ quantity: 10, invoicedQuantity: 2, invoiceableQuantity: 3 });

    expect(quantityInput().value).toBe("3");
    expect(quantityInput().getAttribute("max")).toBe("8");
    expect(
      container.querySelector('input[name="expectedInvoicedQuantity"]')?.getAttribute("value"),
    ).toBe("2");
  });

  it("sin nada facturable precarga el saldo", () => {
    renderForm({ quantity: 10, invoicedQuantity: 2, invoiceableQuantity: 0 });

    expect(quantityInput().value).toBe("8");
    expect(quantityInput().getAttribute("max")).toBe("8");
  });
});

describe("PendingCustomerLifecycleForm · confirmación sin stock", () => {
  it("hasta lo facturable factura de un toque, sin confirmación ni marca", async () => {
    const { user } = renderForm({ invoiceableQuantity: 3 });

    await user.click(screen.getByRole("button", { name: "Facturar" }));

    await waitFor(() => expect(mocks.invoicePendingAction).toHaveBeenCalledOnce());
    expect(submittedFormData().get("id")).toBe("pend-9");
    expect(submittedFormData().get("quantity")).toBe("3");
    expect(submittedFormData().get("expectedInvoicedQuantity")).toBe("0");
    expect(submittedFormData().get("allowWithoutStock")).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirmar facturación sin stock" })).toBeNull();
  });

  it("por encima de lo facturable muestra la confirmación y no envía nada", async () => {
    const { user } = renderForm({ invoiceableQuantity: 3 });

    await enterQuantity(user, "5");
    await user.click(screen.getByRole("button", { name: "Facturar" }));

    const warning = screen.getByRole("status");
    expect(warning.textContent).toContain("Hay stock para 3");
    expect(warning.textContent).toContain("2 sin stock");
    expect(warning.textContent).toContain("no crea stock ni habilita la entrega");
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirmar facturación sin stock" })).toBeTruthy();
    expect(mocks.invoicePendingAction).not.toHaveBeenCalled();
  });

  it("Cancelar no envía nada y vuelve al formulario", async () => {
    const { user } = renderForm({ invoiceableQuantity: 3 });

    await enterQuantity(user, "5");
    await user.click(screen.getByRole("button", { name: "Facturar" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByRole("button", { name: "Confirmar facturación sin stock" })).toBeNull();
    expect(screen.getByRole("button", { name: "Facturar" })).toBeTruthy();
    expect(mocks.invoicePendingAction).not.toHaveBeenCalled();
  });

  it("Confirmar envía la marca, la cantidad y el token", async () => {
    const { user } = renderForm({ quantity: 10, invoicedQuantity: 2, invoiceableQuantity: 0 });

    await user.click(screen.getByRole("button", { name: "Facturar el resto" }));
    await user.click(screen.getByRole("button", { name: "Confirmar facturación sin stock" }));

    await waitFor(() => expect(mocks.invoicePendingAction).toHaveBeenCalledOnce());
    expect(submittedFormData().get("id")).toBe("pend-9");
    expect(submittedFormData().get("quantity")).toBe("8");
    expect(submittedFormData().get("expectedInvoicedQuantity")).toBe("2");
    expect(submittedFormData().get("allowWithoutStock")).toBe("1");
  });

  it("si el servidor igual rechaza, muestra su mensaje", async () => {
    mocks.invoicePendingAction.mockResolvedValue({
      error: "Todavía no hay mercadería cargada para facturar.",
      ok: false,
    });
    const { user } = renderForm({ invoiceableQuantity: 0 });

    await user.click(screen.getByRole("button", { name: "Facturar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar facturación sin stock" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Todavía no hay mercadería cargada para facturar.",
    );
  });
});
