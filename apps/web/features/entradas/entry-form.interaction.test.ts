/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const formActions: Array<(formData: FormData) => Promise<unknown>> = [];
  return {
    createInventoryEntryAction: vi.fn(),
    formActions,
    useActionState: vi.fn((action: (state: unknown, formData: FormData) => Promise<unknown>) => {
      const formAction = async (formData: FormData) => action({ error: null, ok: false }, formData);
      formActions.push(formAction);
      return [{ error: null, ok: false }, formAction, false];
    }),
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: mocks.useActionState };
});

vi.mock("@/server/actions/entry.actions", () => ({
  createInventoryEntryAction: mocks.createInventoryEntryAction,
}));

import { EntryForm } from "./entry-form";

describe("EntryForm · idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.formActions.length = 0;
    mocks.createInventoryEntryAction
      .mockResolvedValueOnce({ error: "No se pudo registrar la entrada. Intentá de nuevo.", ok: false })
      .mockResolvedValueOnce({ error: null, ok: false })
      .mockResolvedValueOnce({ error: null, ok: true });
  });

  afterEach(cleanup);

  it("keeps its key through uncertain retries and rotates it only after confirmed success", async () => {
    const { container } = render(createElement(EntryForm, {
      products: [
        {
          id: "product-1",
          name: "Acetaminofén",
          code: "ACE-1",
          orionCode: "ORN-1",
          laboratoryName: "Genfar",
          unit: "caja",
          identityVersion: 0,
          catalogVersion: 0,
        },
      ],
    }));
    const keyInput = container.querySelector('input[name="idempotencyKey"]') as HTMLInputElement;
    const initialKey = keyInput.value;
    const formAction = mocks.formActions[0]!;
    const formData = new FormData();
    formData.set("idempotencyKey", initialKey);

    await formAction(formData);
    expect((mocks.createInventoryEntryAction.mock.calls[0]![1] as FormData).get("idempotencyKey")).toBe(initialKey);

    await formAction(formData);
    expect((mocks.createInventoryEntryAction.mock.calls[1]![1] as FormData).get("idempotencyKey")).toBe(initialKey);

    await formAction(formData);
    await waitFor(() => expect(mocks.createInventoryEntryAction).toHaveBeenCalledTimes(3));
    expect(keyInput.value).not.toBe(initialKey);
  });
});
