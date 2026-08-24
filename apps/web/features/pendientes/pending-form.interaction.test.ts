/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseBogotaWallTime } from "@/lib/datetime/bogota";
import type { PendingFormState } from "@/server/actions/pending.actions";

const mocks = vi.hoisted(() => ({ createPendingAction: vi.fn() }));

vi.mock("@/server/actions/pending.actions", () => ({
  createPendingAction: mocks.createPendingAction,
}));

import { PendingForm, type ProductOption } from "./pending-form";

// --------------------------------------------------------------------------
// Regresión del incidente de julio/agosto de 2026.
//
// El operador cargaba un pendiente, el registro fallaba y el formulario quedaba
// VACÍO: había que tipear todo de nuevo, hasta cinco veces. La causa no era del
// servidor: React limpia los campos no controlados de un `<form action>` en
// cuanto la acción resuelve, y un error devuelto ES una resolución.
//
// Estas pruebas fijan el contrato en las dos direcciones —error conserva, éxito
// limpia— y lo hacen con Enter y con clic, porque son dos caminos distintos del
// navegador y el incidente se reportó sobre Enter.
// --------------------------------------------------------------------------

// El producto que estos tests cargan YA tiene su código de Orion, y eso es
// deliberado: desde que la identidad es obligatoria, un producto sin código
// frena el envío hasta resolverla, y este archivo no viene a hablar de eso
// sino del eco de los valores tras un fallo. Con uno ya identificado la
// pantalla no pide nada y el contrato que estos tests fijan queda a la vista.
// La captura CON identidad vive en `pending-form.identity.test.ts`.
const PRODUCTS: ProductOption[] = [
  { id: "p1", name: "Acetaminofén", code: "ACE-1", orionCode: "ORN-4100" },
  { id: "p2", name: "Ibuprofeno", code: "IBU-1", orionCode: null },
];

const CARGA = {
  productId: "p1",
  quantity: "2",
  customerName: "Lady Arango",
  customerPhone: "301 6325273",
  customerAddress: "Calle 10 #43-20",
  zone: "El Poblado",
  note: "Va con pedido de Fitostimoline",
  totalAmount: "45.000",
  paidAmount: "20.000",
} as const;

function bogotaNow(wall: string): Date {
  const parsed = parseBogotaWallTime(wall);
  if (!parsed) throw new Error(`bad wall time: ${wall}`);
  return parsed;
}

function renderForm() {
  return render(
    createElement(PendingForm, {
      products: PRODUCTS,
      now: bogotaNow("2026-08-03T10:00"),
    }),
  );
}

function value(container: HTMLElement, name: string): string {
  const el = container.querySelector(`[name="${name}"]`);
  return el ? (el as HTMLInputElement | HTMLSelectElement).value : "<AUSENTE>";
}

/** Carga el formulario completo, como lo haría el operador en el mostrador. */
async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText("Producto"), CARGA.productId);
  const quantity = screen.getByLabelText("Cantidad");
  await user.clear(quantity);
  await user.type(quantity, CARGA.quantity);
  await user.type(screen.getByLabelText("Cliente"), CARGA.customerName);
  await user.type(screen.getByLabelText("Teléfono"), CARGA.customerPhone);
  await user.type(screen.getByLabelText("Dirección (opcional)"), CARGA.customerAddress);
  await user.type(screen.getByLabelText("Zona o barrio"), CARGA.zone);
  await user.type(screen.getByLabelText("Valor total"), CARGA.totalAmount);
  await user.type(screen.getByLabelText("Abono"), CARGA.paidAmount);
  await user.type(screen.getByLabelText("Nota (opcional)"), CARGA.note);
}

/** Enter dentro de un campo de texto: el submit implícito del navegador. */
async function submitWithEnter(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Cliente"), "{Enter}");
}

/**
 * Clic en el botón de envío. Se busca por `type=submit` y no por su texto,
 * porque mientras el envío está en vuelo el botón dice "Guardando…" y un
 * segundo intento no lo encontraría — que es justo lo que estos tests ejercen.
 */
async function submitWithClick(user: ReturnType<typeof userEvent.setup>) {
  const button = document.querySelector('button[type="submit"]');
  if (!button) throw new Error("no hay botón de envío");
  await user.click(button);
}

/**
 * Imita al servidor real: ante un fallo devuelve el eco EXACTO de lo enviado.
 * Es el contrato que hace posible reintentar sin volver a escribir.
 */
function failureEchoing(message: string) {
  return (_prev: PendingFormState, formData: FormData): PendingFormState => {
    const values = Object.fromEntries(
      [
        "productId", "manualName", "manualUnit", "manualMode", "quantity",
        "promisedAt", "customerName", "customerPhone", "customerAddress",
        "note", "zone", "totalAmount", "paidAmount", "idempotencyKey",
      ].map((k) => [k, String(formData.get(k) ?? "")]),
    ) as PendingFormState["values"];
    return {
      error: `${message} Código: PND-K7M2QX`,
      ok: false,
      supportCode: "PND-K7M2QX",
      values,
      submissionId: `fail-${mocks.createPendingAction.mock.calls.length}`,
    };
  };
}

function success(): PendingFormState {
  return { error: null, ok: true, submissionId: "ok-1" };
}

function successWithoutTotal(): PendingFormState {
  return { error: null, ok: true, submissionId: "ok-2", savedWithoutTotalAmount: true };
}

function lastFormData(): FormData {
  const calls = mocks.createPendingAction.mock.calls;
  return calls[calls.length - 1]![1] as FormData;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("PendingForm · un fallo NUNCA borra lo cargado", () => {
  // El caso exacto que reportó el operador: cargar, Enter, y quedarse sin nada.
  it.each([
    ["Enter", submitWithEnter],
    ["clic", submitWithClick],
  ])("conserva todos los campos tras un error del servidor (%s)", async (_label, submit) => {
    mocks.createPendingAction.mockImplementation(
      failureEchoing("No se pudo registrar el pendiente."),
    );
    const user = userEvent.setup();
    const { container } = renderForm();

    await fillForm(user);
    await submit(user);

    await screen.findByRole("alert");

    expect(value(container, "productId")).toBe(CARGA.productId);
    expect(value(container, "quantity")).toBe(CARGA.quantity);
    expect(value(container, "customerName")).toBe(CARGA.customerName);
    expect(value(container, "customerPhone")).toBe(CARGA.customerPhone);
    expect(value(container, "customerAddress")).toBe(CARGA.customerAddress);
    expect(value(container, "zone")).toBe(CARGA.zone);
    expect(value(container, "note")).toBe(CARGA.note);
    expect(value(container, "totalAmount")).toBe(CARGA.totalAmount);
    expect(value(container, "paidAmount")).toBe(CARGA.paidAmount);
  });

  it("conserva los campos ante un error de VALIDACIÓN", async () => {
    mocks.createPendingAction.mockImplementation(
      failureEchoing("Revisá los datos del pendiente."),
    );
    const user = userEvent.setup();
    const { container } = renderForm();

    await fillForm(user);
    await submitWithEnter(user);

    await screen.findByRole("alert");
    expect(value(container, "customerName")).toBe(CARGA.customerName);
    expect(value(container, "customerPhone")).toBe(CARGA.customerPhone);
  });

  // Sesión vencida a mitad de la carga: el peor momento para perder los datos,
  // porque recuperarlos exige recordar lo que dijo un cliente que ya se fue.
  it("conserva los campos cuando la sesión venció", async () => {
    mocks.createPendingAction.mockImplementation(
      failureEchoing("Tu sesión venció. Iniciá sesión de nuevo."),
    );
    const user = userEvent.setup();
    const { container } = renderForm();

    await fillForm(user);
    await submitWithEnter(user);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/sesión venció/i);
    expect(value(container, "customerName")).toBe(CARGA.customerName);
    expect(value(container, "note")).toBe(CARGA.note);
  });

  it("conserva el producto manual y su unidad, no solo la rama de catálogo", async () => {
    mocks.createPendingAction.mockImplementation(failureEchoing("Falló."));
    const user = userEvent.setup();
    const { container } = renderForm();

    await user.click(
      screen.getByLabelText("El producto no está en el catálogo (cargarlo manual)"),
    );
    await user.type(screen.getByLabelText("Producto (manual)"), "ILANA CREMA VAGINAL X 40 GR");
    await user.type(screen.getByLabelText("Unidad (opcional)"), "tubo");
    // Un producto manual no existe todavía, así que nunca tiene código: su
    // identidad es obligatoria y sin ella el envío ni sale.
    await user.type(screen.getByLabelText("Código de Orion"), "ORN-7788");
    await user.type(screen.getByLabelText("Cliente"), CARGA.customerName);
    await user.type(screen.getByLabelText("Teléfono"), CARGA.customerPhone);
    await submitWithEnter(user);

    await screen.findByRole("alert");
    expect(value(container, "manualName")).toBe("ILANA CREMA VAGINAL X 40 GR");
    expect(value(container, "manualUnit")).toBe("tubo");
    // El modo manual sigue activo: volver a la rama de catálogo perdería el dato.
    expect(value(container, "manualMode")).toBe("on");
  });

  it("muestra un código de soporte copiable y no expone detalles internos", async () => {
    mocks.createPendingAction.mockImplementation(failureEchoing("No se pudo registrar."));
    const user = userEvent.setup();
    renderForm();

    await fillForm(user);
    await submitWithEnter(user);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("PND-K7M2QX");
    expect(screen.getByRole("button", { name: "Copiar código" })).toBeTruthy();
    // Nada de stacks ni nombres de tabla/driver en pantalla.
    expect(alert.textContent).not.toMatch(/prisma|postgres|at Object|Error:/i);
  });
});

describe("PendingForm · el éxito limpia, exactamente una vez", () => {
  it.each([
    ["Enter", submitWithEnter],
    ["clic", submitWithClick],
  ])("vacía todos los campos tras un registro confirmado (%s)", async (_label, submit) => {
    mocks.createPendingAction.mockResolvedValue(success());
    const user = userEvent.setup();
    const { container } = renderForm();

    await fillForm(user);
    await submit(user);

    await screen.findByRole("status");
    expect(value(container, "customerName")).toBe("");
    expect(value(container, "customerPhone")).toBe("");
    expect(value(container, "note")).toBe("");
    expect(value(container, "totalAmount")).toBe("");
    expect(value(container, "paidAmount")).toBe("");
    expect(value(container, "productId")).toBe("");
  });

  // La trampa de preservar valores: que reaparezcan en el pendiente SIGUIENTE.
  it("no reaparecen los valores del intento fallido después de un éxito", async () => {
    mocks.createPendingAction.mockImplementationOnce(failureEchoing("Falló."));
    const user = userEvent.setup();
    const { container } = renderForm();

    await fillForm(user);
    await submitWithEnter(user);
    await screen.findByRole("alert");
    expect(value(container, "customerName")).toBe(CARGA.customerName);

    mocks.createPendingAction.mockResolvedValue(success());
    await submitWithEnter(user);

    await screen.findByRole("status");
    expect(value(container, "customerName")).toBe("");
    expect(value(container, "note")).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("PendingForm · valor total desconocido", () => {
  // La corrección de fondo: que nadie escriba "0" porque nadie le dijo que podía
  // dejarlo vacío. El aviso posterior es la red, esto es la solución.
  it("dice en el campo que el valor total se puede dejar vacío", () => {
    mocks.createPendingAction.mockResolvedValue(success());
    renderForm();

    expect(screen.getByText("Si todavía no lo sabés, dejalo vacío.")).toBeTruthy();
  });

  it("avisa cuando el pendiente entró SIN valor total", async () => {
    mocks.createPendingAction.mockResolvedValue(successWithoutTotal());
    const user = userEvent.setup();
    renderForm();

    await fillForm(user);
    await submitWithEnter(user);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Pendiente registrado.");
    expect(status.textContent).toContain("sin valor total");
    // Es un éxito, no un error: no puede aparecer como fallo.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("no agrega el aviso cuando el valor total sí quedó cargado", async () => {
    mocks.createPendingAction.mockResolvedValue(success());
    const user = userEvent.setup();
    renderForm();

    await fillForm(user);
    await submitWithEnter(user);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Pendiente registrado.");
    expect(status.textContent).not.toContain("sin valor total");
  });
});

describe("PendingForm · reintento sin volver a escribir", () => {
  it("reenvía los valores preservados sin que el operador los tipee de nuevo", async () => {
    mocks.createPendingAction.mockImplementation(failureEchoing("Falló."));
    const user = userEvent.setup();
    renderForm();

    await fillForm(user);
    await submitWithEnter(user);
    await screen.findByRole("alert");

    // Segundo envío: NO se escribe nada, solo se reintenta.
    await submitWithEnter(user);
    await waitFor(() => expect(mocks.createPendingAction).toHaveBeenCalledTimes(2));

    const retry = lastFormData();
    expect(retry.get("customerName")).toBe(CARGA.customerName);
    expect(retry.get("customerPhone")).toBe(CARGA.customerPhone);
    expect(retry.get("note")).toBe(CARGA.note);
    expect(retry.get("totalAmount")).toBe(CARGA.totalAmount);
  });

  // Sin esto, cada reintento sería un pendiente nuevo para el servidor: es la
  // mitad cliente de la idempotencia.
  it("reintenta con la MISMA clave de idempotencia", async () => {
    mocks.createPendingAction.mockImplementation(failureEchoing("Falló."));
    const user = userEvent.setup();
    renderForm();

    await fillForm(user);
    await submitWithEnter(user);
    await screen.findByRole("alert");
    const first = lastFormData().get("idempotencyKey");

    await submitWithEnter(user);
    await waitFor(() => expect(mocks.createPendingAction).toHaveBeenCalledTimes(2));

    expect(lastFormData().get("idempotencyKey")).toBe(first);
    expect(String(first)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  // Tras un éxito arranca un pendiente NUEVO: reusar la clave haría que el
  // segundo cliente reciba el pendiente del primero.
  it("estrena clave de idempotencia después de un éxito", async () => {
    mocks.createPendingAction.mockImplementation(failureEchoing("Falló."));
    const user = userEvent.setup();
    renderForm();

    await fillForm(user);
    await submitWithEnter(user);
    await screen.findByRole("alert");
    const failedKey = lastFormData().get("idempotencyKey");

    mocks.createPendingAction.mockResolvedValue(success());
    await submitWithEnter(user);
    await screen.findByRole("status");

    await fillForm(user);
    await submitWithEnter(user);
    await waitFor(() => expect(mocks.createPendingAction).toHaveBeenCalledTimes(3));

    expect(lastFormData().get("idempotencyKey")).not.toBe(failedKey);
  });
});

describe("PendingForm · doble envío", () => {
  it.each([
    ["Enter", submitWithEnter],
    ["clic", submitWithClick],
  ])("no dispara un segundo envío mientras el primero está en vuelo (%s)", async (_label, submit) => {
    let resolveAction: (v: PendingFormState) => void = () => {};
    mocks.createPendingAction.mockImplementation(
      () => new Promise<PendingFormState>((resolve) => { resolveAction = resolve; }),
    );
    const user = userEvent.setup();
    renderForm();

    await fillForm(user);
    await submit(user);
    await submit(user);
    await submit(user);

    expect(mocks.createPendingAction).toHaveBeenCalledTimes(1);
    resolveAction(success());
  });
});

describe("PendingForm · diagnóstico del envío", () => {
  it("distingue Enter de clic para el log del servidor", async () => {
    mocks.createPendingAction.mockResolvedValue(success());
    const user = userEvent.setup();
    renderForm();

    await fillForm(user);
    await submitWithEnter(user);
    await waitFor(() => expect(mocks.createPendingAction).toHaveBeenCalledTimes(1));
    expect(lastFormData().get("submitMethod")).toBe("enter");

    cleanup();
    vi.clearAllMocks();
    mocks.createPendingAction.mockResolvedValue(success());
    const user2 = userEvent.setup();
    renderForm();

    await fillForm(user2);
    await submitWithClick(user2);
    await waitFor(() => expect(mocks.createPendingAction).toHaveBeenCalledTimes(1));
    expect(lastFormData().get("submitMethod")).toBe("click");
  });
});
