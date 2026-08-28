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
const CODELESS_B: ProductOption = {
  id: "p3",
  name: "Acetaminofén gotas",
  code: "ACE-1",
  orionCode: null,
};

function bogotaNow(wall: string): Date {
  const parsed = parseBogotaWallTime(wall);
  if (!parsed) throw new Error(`bad wall time: ${wall}`);
  return parsed;
}

function renderForm(
  state: PendingFormState = { error: null, ok: false },
  products: ProductOption[] = [CODED, CODELESS, CODELESS_B],
) {
  mocks.useActionState.mockReturnValue([state, vi.fn(), false]);
  return render(
    createElement(PendingForm, {
      products,
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

async function enterDeferral(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: /continuar sin sku/i }));
  await user.selectOptions(reasonSelect() as HTMLSelectElement, "CODE_NOT_FOUND");
  await user.type(noteInput() as HTMLTextAreaElement, "Identidad anterior");
}

function expectFreshIdentityDraft() {
  expect(orionInput()?.value).toBe("");
  expect(
    (screen.getByRole("checkbox", { name: /continuar sin sku/i }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  expect(reasonSelect()).toBeNull();
  expect(noteInput()).toBeNull();
}

function conflictState(holder: { productId: string; productName: string }): PendingFormState {
  return {
    error: `Ese código de Orion ya es de "${holder.productName}".`,
    ok: false,
    orionConflict: { holder },
    values: {
      productId: "p2",
      manualName: "",
      manualUnit: "",
      manualMode: "off",
      quantity: "7",
      promisedAt: "2026-08-25T12:00",
      customerName: "Ana Pérez",
      customerPhone: "3001234567",
      customerAddress: "Calle 10 #20-30",
      note: "Entregar en portería",
      zone: "Centro",
      totalAmount: "45.000",
      paidAmount: "20.000",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      orionCode: "ORN-500",
      identitySkippedReason: "",
      identitySkippedNote: "",
      requestedLaboratoryId: "",
      requestedLaboratoryName: "",
    },
  };
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

  // ------------------------------------------------------------------------
  // S2b · 1e-D — pedirlo no alcanza: la pantalla tiene que EXIGIRLO.
  //
  // Un campo que se ve pero se puede dejar vacío enseña que se puede dejar
  // vacío. La exigencia real vive en la acción, pero descubrirla recién
  // después de enviar el pedido entero es la peor forma de enterarse.
  // ------------------------------------------------------------------------
  it("exige el código mientras no se elija la salida", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.selectOptions(productSelect(), "p2");

    expect(orionInput()?.required).toBe(true);
  });

  it("al aplazar, la exigencia se muda del código al motivo", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(productSelect(), "p2");

    await user.click(screen.getByRole("checkbox", { name: /continuar sin sku/i }));

    // El campo obligatorio desaparece con su exigencia: si quedara montado y
    // vacío, el navegador frenaría el envío pidiendo algo que ya no se pide.
    expect(orionInput()).toBeNull();
    expect(reasonSelect()?.required).toBe(true);
  });

  it("al producto MANUAL le exige el código igual que a uno del catálogo", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("checkbox", { name: /no está en el catálogo/i }));

    expect(orionInput()?.required).toBe(true);
  });

  it("ofrece una salida explícita: continuar sin SKU indicando el motivo", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(productSelect(), "p2");

    // Sin la salida, el mostrador se traba cuando Orion se cae: el vendedor
    // tiene un cliente enfrente y el pendiente NO puede depender del ERP.
    await user.click(screen.getByRole("checkbox", { name: /continuar sin sku/i }));

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
    await user.click(screen.getByRole("checkbox", { name: /continuar sin sku/i }));

    // El campo del código desaparece Y deja de postearse: dejarlo con texto
    // adentro mandaría los dos y el envío se rechazaría por contradictorio,
    // culpando al operador de algo que hizo la pantalla.
    expect(orionInput()).toBeNull();
  });

  it("los cinco motivos de la lista cerrada están disponibles", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(productSelect(), "p2");
    await user.click(screen.getByRole("checkbox", { name: /continuar sin sku/i }));

    const options = Array.from(
      (reasonSelect() as HTMLSelectElement).querySelectorAll("option"),
    )
      .map((option) => option.value)
      .filter(Boolean);

    // `NEW_PRODUCT` va primero: es el caso más común al dar de alta productos,
    // y los otros cuatro describen un fracaso al conseguir el código.
    expect(options).toEqual([
      "NEW_PRODUCT",
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

  it("limpia código y aplazamiento al cambiar entre dos productos sin código", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(productSelect(), "p2");
    await user.type(orionInput() as HTMLInputElement, "ORN-A");

    await user.selectOptions(productSelect(), "p3");
    expectFreshIdentityDraft();

    await enterDeferral(user);
    await user.selectOptions(productSelect(), "p2");
    expectFreshIdentityDraft();
  });

  it("limpia código y aplazamiento al pasar de catálogo a carga manual", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(productSelect(), "p2");
    await user.type(orionInput() as HTMLInputElement, "ORN-CATALOGO");

    await user.click(screen.getByRole("checkbox", { name: /no está en el catálogo/i }));
    expectFreshIdentityDraft();

    await user.click(screen.getByRole("checkbox", { name: /no está en el catálogo/i }));
    await enterDeferral(user);
    await user.click(screen.getByRole("checkbox", { name: /no está en el catálogo/i }));
    expectFreshIdentityDraft();
  });

  it("no muestra el código del producto catalogado mientras está en modo manual", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(productSelect(), "p1");
    await user.click(screen.getByRole("checkbox", { name: /no está en el catálogo/i }));

    const shownOutsideOptions = Array.from(document.querySelectorAll("body *")).filter(
      (element) =>
        element.tagName !== "OPTION" &&
        element.tagName !== "SELECT" &&
        element.children.length === 0 &&
        element.textContent?.includes("ORN-500"),
    );
    expect(shownOutsideOptions).toHaveLength(0);
  });

  it("limpia código y aplazamiento al pasar de carga manual a catálogo", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(productSelect(), "p2");
    await user.click(screen.getByRole("checkbox", { name: /no está en el catálogo/i }));
    await user.type(orionInput() as HTMLInputElement, "ORN-MANUAL");

    await user.click(screen.getByRole("checkbox", { name: /no está en el catálogo/i }));
    expectFreshIdentityDraft();

    await user.click(screen.getByRole("checkbox", { name: /no está en el catálogo/i }));
    await enterDeferral(user);
    await user.click(screen.getByRole("checkbox", { name: /no está en el catálogo/i }));
    expectFreshIdentityDraft();
  });

  it("distingue accesiblemente la nota del aplazamiento de la nota general", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(productSelect(), "p2");
    await user.click(screen.getByRole("checkbox", { name: /continuar sin sku/i }));

    expect(
      screen
        .getByRole("textbox", { name: "Nota del aplazamiento (opcional)" })
        .getAttribute("name"),
    ).toBe("identitySkippedNote");
    expect(
      screen.getByRole("textbox", { name: "Nota (opcional)" }).getAttribute("name"),
    ).toBe("note");
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
        requestedLaboratoryId: "",
        requestedLaboratoryName: "",
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
        requestedLaboratoryId: "",
        requestedLaboratoryName: "",
      },
    });

    // La salida ya viene abierta: si el operador tuviera que volver a tildarla
    // para ver lo que ya había elegido, el eco no serviría de nada.
    expect((reasonSelect() as HTMLSelectElement).value).toBe("CODE_NOT_FOUND");
    expect((noteInput() as HTMLTextAreaElement).value).toBe("No aparece en Orion");
  });

  it("recupera el conflicto en un clic seleccionando al dueño presente y conserva el pedido", async () => {
    const user = userEvent.setup();
    renderForm(conflictState({ productId: "p1", productName: CODED.name }));

    await user.click(screen.getByRole("button", { name: /usar eucerin tono claro/i }));

    expect(productSelect().value).toBe("p1");
    expect(orionInput()).toBeNull();
    expect((screen.getByRole("spinbutton", { name: "Cantidad" }) as HTMLInputElement).value).toBe("7");
    expect((screen.getByRole("textbox", { name: "Cliente" }) as HTMLInputElement).value).toBe(
      "Ana Pérez",
    );
    expect(
      (screen.getByRole("textbox", { name: "Nota (opcional)" }) as HTMLInputElement).value,
    ).toBe("Entregar en portería");
  });

  it("no materializa ni envía al dueño ausente y ofrece aplazar o recargar", async () => {
    const user = userEvent.setup();
    renderForm(
      conflictState({ productId: "p9", productName: "Eucerin tono medio" }),
      [CODELESS, CODELESS_B],
    );

    expect(document.querySelector('option[value="p9"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /usar eucerin tono medio/i })).toBeNull();
    expect(screen.getByText(/no está disponible en esta lista/i)).not.toBeNull();
    expect(screen.getByRole("button", { name: /recargar productos/i })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /mantener este producto y aplazar/i }));

    const form = document.querySelector("form");
    if (!form) throw new Error("no hay formulario");
    const submitted = new FormData(form);
    expect(submitted.get("productId")).toBe("p2");
    expect(Array.from(submitted.values())).not.toContain("p9");
  });

  it.each(["producto", "modo manual", "draft de identidad"] as const)(
    "invalida ambas recuperaciones si cambia el %s",
    async (change) => {
      const user = userEvent.setup();
      renderForm(conflictState({ productId: "p1", productName: CODED.name }));

      if (change === "producto") await user.selectOptions(productSelect(), "p3");
      if (change === "modo manual") {
        await user.click(screen.getByRole("checkbox", { name: /no está en el catálogo/i }));
      }
      if (change === "draft de identidad") {
        await user.type(orionInput() as HTMLInputElement, "-corregido");
      }

      expect(screen.queryByRole("button", { name: /usar eucerin tono claro/i })).toBeNull();
      expect(
        screen.queryByRole("button", { name: /mantener este producto y aplazar/i }),
      ).toBeNull();
    },
  );

  it("permite mantener el producto actual y aplazar con el motivo de conflicto", async () => {
    const user = userEvent.setup();
    renderForm(conflictState({ productId: "p1", productName: CODED.name }));

    await user.click(screen.getByRole("button", { name: /mantener este producto y aplazar/i }));

    expect(productSelect().value).toBe("p2");
    expect((reasonSelect() as HTMLSelectElement).value).toBe("CODE_ALREADY_ASSIGNED");
    expect(orionInput()).toBeNull();
    expect((screen.getByRole("textbox", { name: "Teléfono" }) as HTMLInputElement).value).toBe(
      "3001234567",
    );
  });
});
