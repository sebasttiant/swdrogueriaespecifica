/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseBogotaWallTime } from "@/lib/datetime/bogota";
import type { PendingFormState } from "@/server/actions/pending.actions";

const mocks = vi.hoisted(() => ({
  createPendingAction: vi.fn(),
  useActionState: vi.fn(),
}));

vi.mock("@/server/actions/pending.actions", () => ({
  createPendingAction: mocks.createPendingAction,
}));
// El eco de los valores llega por `useActionState`, no por lo que resuelva la
// acción: interceptarlo acá es la única forma de montar la pantalla YA en el
// estado "el intento anterior falló y estos son los datos que había".
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: mocks.useActionState };
});

import { PendingForm, type ProductOption } from "./pending-form";

// --------------------------------------------------------------------------
// S2b · 1e-C1 — la pantalla pide la identidad de Orion.
//
// La regla que gobierna todo esto: al producto que YA tiene código no se le
// vuelve a preguntar. Preguntar de nuevo por un dato que el sistema ya sabe es
// cómo se entrena a la gente a tipear cualquier cosa para sacarse el campo de
// encima, y un código inventado es peor que ninguno.
// --------------------------------------------------------------------------

const CODED: ProductOption = {
  id: "p1",
  name: "Eucerin tono claro",
  code: "EUC-1",
  orionCode: "ORN-500",
};
const CODELESS: ProductOption = {
  id: "p2",
  name: "Ibuprofeno jarabe",
  code: "IBU-1",
  orionCode: null,
};

function bogotaNow(wall: string): Date {
  const parsed = parseBogotaWallTime(wall);
  if (!parsed) throw new Error(`bad wall time: ${wall}`);
  return parsed;
}

function renderForm(state: PendingFormState = { error: null, ok: false }) {
  mocks.useActionState.mockReturnValue([state, vi.fn(), false]);
  return render(
    createElement(PendingForm, {
      products: [CODED, CODELESS],
      now: bogotaNow("2026-08-24T10:00"),
      defaultCustom: false,
    }),
  );
}

/**
 * El selector se busca por `name` y no por etiqueta: la pantalla dice
 * "Producto" en más de un lugar y una búsqueda por texto ahí es ambigua.
 */
function productSelect(): HTMLSelectElement {
  const select = document.querySelector<HTMLSelectElement>('select[name="productId"]');
  if (!select) throw new Error("no hay selector de producto");
  return select;
}

/** El campo del código, cuando la pantalla decidió pedirlo. */
function orionInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[name="orionCode"]');
}

function reasonSelect(): HTMLSelectElement | null {
  return document.querySelector<HTMLSelectElement>('select[name="identitySkippedReason"]');
}

function noteInput(): HTMLElement | null {
  return document.querySelector('[name="identitySkippedNote"]');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("PendingForm · identidad Orion", () => {
  it("al producto que YA tiene código le muestra el suyo y no pide nada", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.selectOptions(productSelect(), "p1");

    // Se busca FUERA del selector a propósito: la etiqueta de la opción ya
    // menciona el código, y darlo por bueno haría pasar este test sin que la
    // pantalla muestre nada. Lo que se prueba es que el código está a la
    // vista sin desplegar el selector.
    const shown = Array.from(document.querySelectorAll("body *")).filter(
      (element) =>
        element.tagName !== "OPTION" &&
        element.tagName !== "SELECT" &&
        element.children.length === 0 &&
        element.textContent?.includes("ORN-500"),
    );
    expect(shown.length).toBeGreaterThan(0);
    expect(orionInput()).toBeNull();
    expect(reasonSelect()).toBeNull();
  });

  it("al producto SIN código le pide el código", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.selectOptions(productSelect(), "p2");

    expect(orionInput()).not.toBeNull();
  });

  it("ofrece una salida explícita: seguir sin el código indicando el motivo", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(productSelect(), "p2");

    // Sin la salida, el mostrador se traba cuando Orion se cae: el vendedor
    // tiene un cliente enfrente y el pendiente NO puede depender del ERP.
    await user.click(screen.getByRole("checkbox", { name: /sin el código/i }));

    expect(reasonSelect()).not.toBeNull();
    expect(noteInput()).not.toBeNull();
  });

  it("la salida y el código son EXCLUYENTES en pantalla, no solo en el validador", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(productSelect(), "p2");

    const input = orionInput();
    expect(input).not.toBeNull();
    await user.type(input as HTMLInputElement, "ORN-999");
    await user.click(screen.getByRole("checkbox", { name: /sin el código/i }));

    // El campo del código desaparece Y deja de postearse: dejarlo con texto
    // adentro mandaría los dos y el envío se rechazaría por contradictorio,
    // culpando al operador de algo que hizo la pantalla.
    expect(orionInput()).toBeNull();
  });

  it("los cuatro motivos de la lista cerrada están disponibles", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(productSelect(), "p2");
    await user.click(screen.getByRole("checkbox", { name: /sin el código/i }));

    const options = Array.from(
      (reasonSelect() as HTMLSelectElement).querySelectorAll("option"),
    )
      .map((option) => option.value)
      .filter(Boolean);

    expect(options).toEqual([
      "ORION_UNAVAILABLE",
      "CODE_NOT_FOUND",
      "CODE_ALREADY_ASSIGNED",
      "OTHER",
    ]);
  });

  it("el producto MANUAL siempre pide identidad: no existe, no puede tener código", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("checkbox", { name: /no está en el catálogo/i }));

    expect(orionInput()).not.toBeNull();
  });

  it("tras un fallo vuelve el código tipeado, no un campo en blanco", async () => {
    renderForm({
      error: "Ese código de Orion ya es de otro producto.",
      ok: false,
      values: {
        productId: "p2",
        manualName: "",
        manualUnit: "",
        manualMode: "off",
        quantity: "2",
        promisedAt: "",
        customerName: "Ana",
        customerPhone: "3001234567",
        customerAddress: "",
        note: "",
        zone: "",
        totalAmount: "",
        paidAmount: "",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        orionCode: "ORN-999",
        identitySkippedReason: "",
        identitySkippedNote: "",
      },
    });

    expect(orionInput()?.value).toBe("ORN-999");
  });

  it("tras un fallo aplazado vuelve el motivo elegido y su nota", async () => {
    renderForm({
      error: "No se pudo registrar el pendiente.",
      ok: false,
      values: {
        productId: "p2",
        manualName: "",
        manualUnit: "",
        manualMode: "off",
        quantity: "2",
        promisedAt: "",
        customerName: "Ana",
        customerPhone: "3001234567",
        customerAddress: "",
        note: "",
        zone: "",
        totalAmount: "",
        paidAmount: "",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        orionCode: "",
        identitySkippedReason: "CODE_NOT_FOUND",
        identitySkippedNote: "No aparece en Orion",
      },
    });

    // La salida ya viene abierta: si el operador tuviera que volver a tildarla
    // para ver lo que ya había elegido, el eco no serviría de nada.
    expect((reasonSelect() as HTMLSelectElement).value).toBe("CODE_NOT_FOUND");
    expect((noteInput() as HTMLTextAreaElement).value).toBe("No aparece en Orion");
  });
});
