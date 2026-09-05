import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

// La Server Action no corre en el render: solo tiene que existir para que
// `useActionState` la reciba. Mockearla evita arrastrar "use server".
vi.mock("@/server/actions/missing-report.actions", () => ({
  createMissingReportAction: vi.fn(),
}));

// El selector de laboratorio habla con sus propias Server Actions. Igual que
// arriba: no corren en el render, solo tienen que existir.
vi.mock("@/server/actions/laboratory.actions", () => ({
  searchLaboratoriesAction: vi.fn(),
  createLaboratoryAction: vi.fn(),
}));

import {
  MAX_MISSING_REPORT_NAME_LENGTH,
  MAX_MISSING_REPORT_PRESENTATION_LENGTH,
  MAX_MISSING_REPORT_SELLER_CODE_LENGTH,
} from "./schema";
import { MissingReportForm } from "./missing-report-form";

type ActionState = { error: string | null; ok: boolean };

const IDLE: ActionState = { error: null, ok: false };

function mockActionState(state: ActionState, isPending = false) {
  useActionStateMock.mockReturnValue([state, vi.fn(), isPending]);
}

function render(props: Partial<{ defaultOpen: boolean }> = {}): string {
  return renderToStaticMarkup(
    createElement(MissingReportForm, { defaultOpen: props.defaultOpen ?? false }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActionState(IDLE);
});

describe("MissingReportForm · collapsed by default", () => {
  it("shows only the compact Reportar faltante trigger, with no fields mounted", () => {
    const html = render();

    expect(html).toContain("Reportar faltante");
    expect(html).not.toContain('name="rawName"');
    expect(html).not.toContain("Nombre del producto");
    expect(html).not.toContain("Enviar reporte");
  });

  // El éxito/error de `useActionState` sobrevive al colapso: si no se viera, el
  // vendedor no sabría si su reporte entró.
  it("keeps the success confirmation visible while collapsed", () => {
    mockActionState({ error: null, ok: true });

    const html = render();

    expect(html).toContain('role="status"');
    expect(html).toContain("Reporte enviado para revisión");
  });

  it("keeps a server error visible while collapsed", () => {
    mockActionState({ error: "Escribí el nombre del producto.", ok: false });

    const html = render();

    expect(html).toContain('role="alert"');
    expect(html).toContain("Escribí el nombre del producto.");
  });
});

describe("MissingReportForm · open", () => {
  it("mounts rawName and optional sellerCode fields", () => {
    const html = render({ defaultOpen: true });

    expect(html).toContain('name="rawName"');
    expect(html).toContain("Nombre del producto");
    expect(html).toContain("Pegá el nombre desde Orión");
    expect(html).toContain('name="sellerCode"');
    expect(html).toContain("Código del vendedor (opcional)");
    expect(html).toContain("Enviar reporte");
  });

  // Contrato exacto con la Server Action: rawName y sellerCode opcional viajan.
  // Nada de identidad, catálogo, cantidad, proveedor ni foto — el reporterId lo
  // pone el servidor.
  it("submits only rawName and optional sellerCode", () => {
    const html = render({ defaultOpen: true });

    expect(html).not.toContain('name="reporterId"');
    expect(html).not.toContain('name="productId"');
    expect(html).not.toContain('name="quantity"');
    expect(html).not.toContain('name="orderedQuantity"');
    expect(html).not.toContain('name="supplierId"');
    expect(html).not.toContain('type="file"');
  });

  it("bounds the input length to protect the server contract", () => {
    const html = render({ defaultOpen: true });

    // HTML attributes are case-insensitive; react-dom renders the prop verbatim.
    expect(html).toContain(`maxLength="${MAX_MISSING_REPORT_NAME_LENGTH}"`);
    expect(html).toContain(`maxLength="${MAX_MISSING_REPORT_SELLER_CODE_LENGTH}"`);
    expect(html).toContain("required");
  });

  it("shows no feedback in the idle state", () => {
    mockActionState(IDLE);

    const html = render({ defaultOpen: true });

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
  });

  it("does not resurrect management-only wording", () => {
    const html = render({ defaultOpen: true });

    expect(html).not.toContain("Autorizar");
    expect(html).not.toContain("Pedir");
    expect(html).not.toContain("Cantidad");
    expect(html).not.toContain("proveedor");
  });

  it("surfaces the server action's specific error message", () => {
    mockActionState({ error: "El nombre del producto es demasiado largo.", ok: false });

    const html = render({ defaultOpen: true });

    expect(html).toContain('role="alert"');
    expect(html).toContain("El nombre del producto es demasiado largo.");
  });

  it("shows the confirmation on success", () => {
    mockActionState({ error: null, ok: true });

    const html = render({ defaultOpen: true });

    expect(html).toContain('role="status"');
    expect(html).toContain("Reporte enviado para revisión");
    // No promete que ya fue pedido: es solo un reporte para revisión.
    expect(html).not.toContain("Pedido");
  });

  // Doble envío: mientras la acción corre, el botón de envío queda deshabilitado.
  it("disables the submit button while the action is pending", () => {
    mockActionState(IDLE, true);

    const html = render({ defaultOpen: true });

    // El botón de submit lleva `disabled`, y el label pasa a "Enviando…".
    expect(html).toMatch(/<button type="submit"[^>]*\bdisabled\b/);
    expect(html).toContain("Enviando…");
  });

  // Un nombre largo pegado desde Orión no debe romper el layout: los mensajes
  // envuelven en vez de forzar scroll horizontal.
  it("lets long messages wrap instead of overflowing", () => {
    mockActionState({ error: "x".repeat(120), ok: false });

    const html = render({ defaultOpen: true });

    expect(html).toContain("break-words");
  });
});

// --------------------------------------------------------------------------
// Presentación y laboratorio (opcionales).
//
// El vendedor reporta desde el celular, de pie y con un cliente adelante. Estos
// dos campos suman información útil para comprar, pero NO pueden costarle el
// reporte: si estorban, el vendedor deja de reportar y el faltante no existe.
// --------------------------------------------------------------------------
describe("MissingReportForm · presentación y laboratorio", () => {
  it("ofrece los dos campos, rotulados como opcionales", () => {
    const html = render({ defaultOpen: true });

    expect(html).toContain("Presentación (opcional)");
    expect(html).toContain('name="presentation"');
    expect(html).toContain("Laboratorio (opcional)");
    expect(html).toContain('name="requestedLaboratoryId"');
    expect(html).toContain('name="requestedLaboratoryName"');
  });

  // Lo que protege el reporte rápido: sigue habiendo UN solo campo obligatorio.
  it("mantiene el nombre del producto como único campo obligatorio", () => {
    const html = render({ defaultOpen: true });

    expect(countOccurrences(html, "required")).toBe(1);
  });

  it("acota la presentación al mismo largo que el schema", () => {
    const html = render({ defaultOpen: true });

    const field = html.slice(html.indexOf("Presentación (opcional)"));
    expect(field.slice(0, field.indexOf('name="presentation"'))).toContain(
      `maxLength="${MAX_MISSING_REPORT_PRESENTATION_LENGTH}"`,
    );
  });

  // El ORDEN es la decisión, no un accidente: nombre, después lo que describe
  // al mismo producto, y el código del vendedor al final porque no habla del
  // producto sino de quién reporta.
  it("pone los dos campos entre el nombre y el código del vendedor", () => {
    const html = render({ defaultOpen: true });

    const posiciones = [
      "Nombre del producto",
      "Presentación (opcional)",
      "Laboratorio (opcional)",
      "Código del vendedor (opcional)",
    ].map((rotulo) => html.indexOf(rotulo));

    expect(posiciones).toEqual([...posiciones].sort((a, b) => a - b));
    expect(posiciones.every((posicion) => posicion >= 0)).toBe(true);
  });

  // Colapsado no monta NADA: ni los campos nuevos ni el selector, que además
  // consulta a la red. Si se montara igual, cada visita a Faltantes pagaría un
  // componente que nadie abrió.
  it("no monta los campos nuevos mientras está colapsado", () => {
    const html = render();

    expect(html).not.toContain("Presentación (opcional)");
    expect(html).not.toContain("Laboratorio (opcional)");
    expect(html).not.toContain('name="requestedLaboratoryId"');
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
