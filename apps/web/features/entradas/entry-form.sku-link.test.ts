/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntryFormState } from "@/server/actions/entry.actions";

const mocks = vi.hoisted(() => ({
  estado: { error: null, ok: false } as EntryFormState,
}));

// El estado lo produce la Server Action; acá interesa qué HACE la pantalla con
// él, así que se inyecta directo en vez de atravesar el servidor.
//
// Va en archivo aparte de `entry-form.interaction.test.ts` porque esa prueba
// mockea `react` entero para observar la clave de idempotencia: dos estrategias
// de mock incompatibles sobre el mismo componente.
vi.mock("@/lib/hooks/use-action-state", () => ({
  useActionState: () => [mocks.estado, vi.fn(), false],
}));

vi.mock("@/server/actions/entry.actions", () => ({
  createInventoryEntryAction: vi.fn(),
}));

import { EntryForm, type ProductOption } from "./entry-form";

// --------------------------------------------------------------------------
// El rechazo por falta de SKU tiene que llevar a algún lado.
//
// El mensaje decía "Completalo en Productos" y ahí terminaba. Bodega quedaba
// con la caja en la mano y tres productos de nombre casi igual para elegir —
// que es el error que este rechazo existe para impedir. Un mensaje que manda a
// resolver algo sin decir dónde no cierra el paso: lo traslada.
//
// El servidor YA sabe qué producto rechazó. Guardar ese id y no usarlo sería
// hacerle repetir a la persona una búsqueda que el sistema no necesita.
// --------------------------------------------------------------------------

const RECHAZO =
  '"Gel Caliente Muscular" todavía no tiene SKU (código de Orión). Completalo y volvé a registrar la entrada.';

const SIN_SKU: ProductOption = {
  id: "prod-gel-1",
  name: "Gel Caliente Muscular",
  code: "PROV-euc2",
  orionCode: null,
  laboratoryName: null,
  unit: "caja",
  identityVersion: 0,
  catalogVersion: 0,
};

const CON_SKU: ProductOption = {
  ...SIN_SKU,
  id: "prod-gel-2",
  name: "Gel Identificado",
  orionCode: "ORI-7788",
};

const montar = (products = [SIN_SKU]) =>
  render(createElement(EntryForm, { products }));

const enlaceSku = () => screen.queryByRole("link", { name: /completar el sku/i });

beforeEach(() => {
  mocks.estado = { error: null, ok: false };
});

afterEach(cleanup);

describe("registro de entrada · excepción explícita sin SKU", () => {
  it("muestra advertencia y confirmación solo para el producto sin SKU", async () => {
    const user = userEvent.setup();
    montar([SIN_SKU, CON_SKU]);

    await user.selectOptions(screen.getByLabelText("Producto"), SIN_SKU.id);
    expect(screen.getByText(/todavía no tiene código de Orión/i)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /recibir inventario sin código/i })).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Producto"), CON_SKU.id);
    expect(screen.queryByRole("checkbox", { name: /recibir inventario sin código/i })).toBeNull();
  });

  it("solo muestra el motivo después de una confirmación consciente", async () => {
    const user = userEvent.setup();
    montar();
    await user.selectOptions(screen.getByLabelText("Producto"), SIN_SKU.id);

    expect(screen.queryByLabelText("Motivo de recepción sin código")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /recibir inventario sin código/i }));

    const reason = screen.getByLabelText("Motivo de recepción sin código");
    expect(reason.getAttribute("required")).not.toBeNull();
    expect(screen.getByLabelText("Detalle adicional (opcional)")).toBeTruthy();
  });

  it("ofrece resolver el producto exacto en vez de crear otra identidad", async () => {
    const user = userEvent.setup();
    montar();
    await user.selectOptions(screen.getByLabelText("Producto"), SIN_SKU.id);

    expect(screen.getByRole("link", { name: /completar el código de Orión/i }).getAttribute("href"))
      .toBe(`/productos/${SIN_SKU.id}`);
  });
});

describe("registro de entrada · rechazo por falta de SKU", () => {
  it("ofrece el enlace al producto que el servidor rechazó", () => {
    mocks.estado = { error: RECHAZO, ok: false, resolveSkuForProductId: "prod-gel-1" };

    montar();

    expect(enlaceSku()?.getAttribute("href")).toBe("/productos/prod-gel-1");
  });

  it("sigue mostrando el motivo, no solo el enlace", () => {
    mocks.estado = { error: RECHAZO, ok: false, resolveSkuForProductId: "prod-gel-1" };

    montar();

    expect(screen.getByRole("alert").textContent).toContain("todavía no tiene SKU");
  });

  // Un rechazo por otra causa —cantidad inválida, laboratorio que no coincide—
  // no se arregla cargando un SKU. Ofrecerlo ahí manda a la persona a tocar el
  // catálogo por un problema que no está en el catálogo.
  it("NO ofrece el enlace cuando el rechazo es por otra causa", () => {
    mocks.estado = { error: "La cantidad debe ser mayor a cero.", ok: false };

    montar();

    expect(enlaceSku()).toBeNull();
  });

  it("no muestra nada de esto cuando el formulario todavía no se envió", () => {
    montar();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(enlaceSku()).toBeNull();
  });
});
