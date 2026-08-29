/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
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

import { EntryForm } from "./entry-form";

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
  '"Gel Caliente Muscular" todavía no tiene SKU (código de Orion). Completalo y volvé a registrar la entrada.';

const montar = () =>
  render(
    createElement(EntryForm, {
      products: [
        {
          id: "prod-gel-1",
          name: "Gel Caliente Muscular",
          code: "PROV-euc2",
          orionCode: null,
          laboratoryName: null,
        },
      ],
    }),
  );

const enlaceSku = () => screen.queryByRole("link", { name: /completar el sku/i });

beforeEach(() => {
  mocks.estado = { error: null, ok: false };
});

afterEach(cleanup);

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
