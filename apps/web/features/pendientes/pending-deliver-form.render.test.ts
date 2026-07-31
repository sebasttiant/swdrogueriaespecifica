import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/pending.actions", () => ({
  deliverPendingAction: vi.fn(),
}));

import { PendingDeliverForm } from "./pending-deliver-form";

describe("PendingDeliverForm", () => {
  beforeEach(() => {
    useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
  });

  it.each([4, 6])("preloads and caps the partial delivery at %i of 10", (remaining) => {
    const html = renderToStaticMarkup(
      createElement(PendingDeliverForm, { pendingId: `pending-${remaining}`, remaining }),
    );

    expect(html).toContain(`max="${remaining}"`);
    expect(html).toContain(`value="${remaining}"`);
  });
});
