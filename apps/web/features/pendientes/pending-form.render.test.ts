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
  props: Partial<{ now: Date; defaultCustom: boolean; zones: string[] }> = {},
): string {
  return renderToStaticMarkup(
    createElement(PendingForm, {
      products: PRODUCTS,
      zones: props.zones,
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

describe("PendingForm · seguimiento del cliente", () => {
  it("postea la zona y los dos montos del pago", () => {
    const html = render();

    expect(html).toContain('name="zone"');
    expect(html).toContain('name="totalAmount"');
    expect(html).toContain('name="paidAmount"');
  });

  // El operador escribe "45.000": un input numérico rechazaría el punto de
  // miles, así que el campo es de texto con teclado numérico.
  it("usa texto con teclado numérico para los montos, no type=number", () => {
    const html = render();

    // React serializa el atributo en camelCase; el HTML no distingue mayúsculas.
    expect(html).toContain('inputMode="numeric"');
    expect(html).not.toMatch(/name="totalAmount"[^>]*type="number"/);
    expect(html).not.toMatch(/name="paidAmount"[^>]*type="number"/);
  });

  it("sugiere las zonas ya usadas sin impedir escribir una nueva", () => {
    const html = render({ zones: ["Norte", "Centro"] });

    expect(html).toContain("<datalist");
    expect(html).toContain('value="Norte"');
    expect(html).toContain('value="Centro"');
    // Es un input libre, no un select cerrado.
    expect(html).toMatch(/<input[^>]*name="zone"/);
  });

  it("no monta un datalist vacío cuando todavía no hay zonas cargadas", () => {
    const html = render({ zones: [] });

    expect(html).not.toContain("<datalist");
  });

  // "Pagado" no es un campo que se postee: es el resultado de que el abono
  // cubra el total. Si apareciera un input, el estado podría contradecir a los
  // montos, que es justo lo que este diseño evita.
  it("no postea ningún flag de pagado: el estado se deriva", () => {
    const html = render();

    expect(html).toContain("Pagó todo");
    expect(html).not.toContain('name="paid"');
    expect(html).not.toContain('name="isPaid"');
    expect(html).not.toContain('type="checkbox" name="paid');
  });
});

describe("PendingForm · datos obligatorios del cliente", () => {
  it("postea el teléfono del cliente", () => {
    const html = render();

    expect(html).toContain('name="customerPhone"');
    // Teclado telefónico en el celular: el 90% del uso es iPhone.
    expect(html).toContain('type="tel"');
  });

  // Gerencia los pidió obligatorios: sin nombre no se sabe a quién se le
  // prometió, sin teléfono no se le puede avisar que llegó.
  it("marca cliente y teléfono como requeridos, y ya no dice (opcional)", () => {
    const html = render();

    // React emite `required` antes que `name`: se ancla por el id del input.
    expect(html).toMatch(/<input[^>]*id="customerName"[^>]*required/);
    expect(html).toMatch(/<input[^>]*id="customerPhone"[^>]*required/);
    expect(html).not.toContain("Cliente (opcional)");
  });

  // La zona se lee junto a la promesa porque con esas dos gerencia prioriza.
  it("ubica la zona junto a la entrega prometida, antes que el cliente", () => {
    const html = render();

    const promised = html.indexOf("Entrega prometida");
    const zone = html.indexOf('name="zone"');
    const customer = html.indexOf('name="customerName"');

    expect(promised).toBeGreaterThan(-1);
    expect(zone).toBeGreaterThan(promised);
    expect(zone).toBeLessThan(customer);
  });
});

describe("PendingForm · dirección de entrega", () => {
  it("postea un campo de dirección opcional", () => {
    const html = render();

    expect(html).toContain('name="customerAddress"');
    expect(html).toContain("Dirección (opcional)");
    // Opcional: no lleva `required` como cliente y teléfono.
    expect(html).not.toMatch(/id="customerAddress"[^>]*required/);
  });
});
