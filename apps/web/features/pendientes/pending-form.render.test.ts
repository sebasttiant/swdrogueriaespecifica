import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

vi.mock("@/server/actions/pending.actions", () => ({
  createPendingAction: vi.fn(),
}));

import { parseBogotaWallTime } from "@/lib/datetime/bogota";

import { PendingForm } from "./pending-form";

const PRODUCTS = [{ id: "p1", name: "Acetaminofén", code: "ACE-1" }];

function bogotaNow(wall: string): Date {
  const parsed = parseBogotaWallTime(wall);
  if (!parsed) throw new Error(`bad wall time: ${wall}`);
  return parsed;
}

function render(
  props: Partial<{ now: Date; defaultCustom: boolean }> = {},
): string {
  return renderToStaticMarkup(
    createElement(PendingForm, {
      products: PRODUCTS,
      now: props.now ?? bogotaNow("2026-07-24T10:00"),
      defaultCustom: props.defaultCustom ?? false,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);
});

describe("PendingForm · entrega prometida", () => {
  it("offers the three quick options instead of forcing the date picker", () => {
    const html = render();

    expect(html).toContain("Hoy antes de las 18:00");
    expect(html).toContain("Mañana antes de las 12:00");
    expect(html).toContain("Mañana antes de las 18:00");
    expect(html).toContain("Personalizado");
  });

  // El contrato con el backend no cambia: se sigue enviando `promisedAt`.
  it("keeps submitting a promisedAt field, pre-filled with the default", () => {
    const html = render({ now: bogotaNow("2026-07-24T10:00") });

    expect(html).toContain('name="promisedAt"');
    expect(html).toContain('value="2026-07-24T18:00"');
  });

  // En modo rápido no se monta el date picker: es el caso raro.
  it("does not mount the datetime picker in quick mode", () => {
    const html = render({ defaultCustom: false });

    expect(html).not.toContain('type="datetime-local"');
  });

  it("reveals the original datetime picker in custom mode", () => {
    const html = render({ defaultCustom: true });

    expect(html).toContain('type="datetime-local"');
  });

  // Un botón cuya hora ya pasó no se ofrece como activable.
  it("disables the today option when the Bogota time is already past 18:00", () => {
    const html = render({ now: bogotaNow("2026-07-24T19:00") });

    expect(html).toMatch(/Hoy antes de las 18:00<\/button>/);
    // El default cae a mañana 12:00 cuando hoy 18:00 ya pasó.
    expect(html).toContain('value="2026-07-25T12:00"');
  });

  // Mobile-first: el grupo de botones envuelve en pantallas angostas (iPhone).
  it("lets the quick options wrap on a narrow screen", () => {
    const html = render();

    expect(html).toContain("flex-wrap");
  });

  it("preserves the rest of the form", () => {
    const html = render();

    expect(html).toContain('name="quantity"');
    expect(html).toContain('name="customerName"');
    expect(html).toContain('name="note"');
    expect(html).toContain("Registrar pendiente");
  });
});
