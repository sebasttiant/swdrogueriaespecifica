/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ linkOrionCodeAction: vi.fn() }));

vi.mock("@/server/actions/sku.actions", () => ({
  linkOrionCodeAction: mocks.linkOrionCodeAction,
}));

import { OrionLinkForm } from "./orion-link-form";

const PROPS = { productId: "prod-17", identityVersion: 8 } as const;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("OrionLinkForm · authorization rejection", () => {
  it("keeps the exact entered code and shows the actionable error", async () => {
    mocks.linkOrionCodeAction.mockResolvedValue({
      error: "Tu sesión venció. Iniciá sesión de nuevo y volvé acá.",
      ok: false,
    });
    const user = userEvent.setup();
    render(createElement(OrionLinkForm, PROPS));
    const input = screen.getByRole("textbox", { name: "Código de Orión" }) as HTMLInputElement;

    await user.type(input, "ORION-RETRY-7702-A");
    await user.click(screen.getByRole("button", { name: "Vincular" }));

    await waitFor(() => expect(mocks.linkOrionCodeAction).toHaveBeenCalledOnce());
    const submitted = mocks.linkOrionCodeAction.mock.calls[0]?.[1] as FormData;
    expect(submitted.get("orionCode")).toBe("ORION-RETRY-7702-A");
    expect(submitted.get("productId")).toBe("prod-17");
    expect(submitted.get("expectedVersion")).toBe("8");
    expect((await screen.findByRole("alert")).textContent).toMatch(/sesión venció/i);
    expect(input.value).toBe("ORION-RETRY-7702-A");
  });
});

describe("OrionLinkForm · successful link", () => {
  it("clears the entered code once and preserves the success feedback", async () => {
    mocks.linkOrionCodeAction.mockResolvedValue({ error: null, ok: true });
    const user = userEvent.setup();
    render(createElement(OrionLinkForm, PROPS));
    const input = screen.getByRole("textbox", { name: "Código de Orión" }) as HTMLInputElement;

    await user.type(input, "ORION-SUCCESS-7702-A");
    await user.click(screen.getByRole("button", { name: "Vincular" }));

    await waitFor(() => expect(mocks.linkOrionCodeAction).toHaveBeenCalledOnce());
    const submitted = mocks.linkOrionCodeAction.mock.calls[0]?.[1] as FormData;
    expect(submitted.get("orionCode")).toBe("ORION-SUCCESS-7702-A");
    expect(submitted.get("productId")).toBe("prod-17");
    expect(submitted.get("expectedVersion")).toBe("8");
    expect((await screen.findByRole("status")).textContent).toMatch(/código vinculado/i);
    await waitFor(() => expect(input.value).toBe(""));
  });
});
