// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { refresh, useRouterMock } = vi.hoisted(() => {
  const refresh = vi.fn();
  return {
    refresh,
    useRouterMock: vi.fn(() => ({ refresh })),
  };
});

vi.mock("next/navigation", () => ({ useRouter: useRouterMock }));

import { useActionState } from "./use-action-state";

// --------------------------------------------------------------------------
// Este hook existe para que el operador NO tenga que apretar F5.
//
// Las Server Actions invalidan el caché del servidor, pero el árbol que el
// navegador ya tiene no se vuelve a pedir solo. El vendedor registraba un
// pendiente y la fila no aparecía hasta recargar a mano.
// --------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
  useRouterMock.mockReturnValue({ refresh });
});

/** Monta un componente que expone el `dispatch` del hook para la prueba. */
function montar(accion: (previo: string, carga: string) => string) {
  const contenedor = document.createElement("div");
  document.body.appendChild(contenedor);
  let disparar: ((carga: string) => void) | null = null;

  function Sonda() {
    const [estado, dispatch] = useActionState(accion, "inicial");
    disparar = dispatch;
    return createElement("output", null, estado);
  }

  const root = createRoot(contenedor);
  act(() => {
    root.render(createElement(Sonda));
  });

  return {
    disparar: (carga: string) => act(() => disparar?.(carga)),
    texto: () => contenedor.textContent,
    desmontar: () => act(() => root.unmount()),
  };
}

describe("useActionState del proyecto", () => {
  it("NO refresca al montar: el estado inicial no es una respuesta", () => {
    const { desmontar } = montar((_previo, carga) => carga);

    expect(refresh).not.toHaveBeenCalled();
    desmontar();
  });

  it("refresca cuando la acción devuelve un estado nuevo", () => {
    const { disparar, texto, desmontar } = montar((_previo, carga) => carga);

    disparar("respuesta");

    expect(texto()).toBe("respuesta");
    expect(refresh).toHaveBeenCalledTimes(1);
    desmontar();
  });

  it("refresca una vez por respuesta, no una vez por render", () => {
    const { disparar, desmontar } = montar((_previo, carga) => carga);

    disparar("uno");
    disparar("dos");

    expect(refresh).toHaveBeenCalledTimes(2);
    desmontar();
  });

  // Distinguir éxito de error exigiría conocer la forma del estado de cada
  // acción, que es justo el acoplamiento que este envoltorio evita. Refrescar
  // de más cuesta un fetch; refrescar de menos deja datos viejos en pantalla.
  it("refresca también cuando la respuesta es un rechazo", () => {
    const { disparar, desmontar } = montar(() => "error: faltan datos");

    disparar("lo que sea");

    expect(refresh).toHaveBeenCalledTimes(1);
    desmontar();
  });

  it("no refresca si la acción devuelve el MISMO estado", () => {
    const mismo = "sin cambios";
    const { disparar, desmontar } = montar(() => mismo);

    // El primer disparo cambia "inicial" -> "sin cambios"; el segundo devuelve
    // exactamente el mismo valor y no hay nada nuevo que mostrar.
    disparar("a");
    disparar("b");

    expect(refresh).toHaveBeenCalledTimes(1);
    desmontar();
  });
});

describe("useActionState del proyecto · sin App Router", () => {
  // `renderToStaticMarkup` no monta router, y `useRouter` lanza ahí. Un
  // formulario no puede reventar por no poder refrescar.
  it("renderiza igual cuando useRouter lanza", () => {
    useRouterMock.mockImplementation(() => {
      throw new Error("invariant expected app router to be mounted");
    });

    function Sonda() {
      const [estado] = useActionState((_p: string, c: string) => c, "listo");
      return createElement("output", null, estado);
    }

    expect(() => renderToStaticMarkup(createElement(Sonda))).not.toThrow();
    expect(renderToStaticMarkup(createElement(Sonda))).toContain("listo");
  });
});
