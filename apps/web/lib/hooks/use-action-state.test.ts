// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** El refresco se agrupa en un microtask: hay que dejarlo correr. */
const tick = () => act(async () => { await Promise.resolve(); });

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
  it("NO refresca al montar: el estado inicial no es una respuesta", async () => {
    const { desmontar } = montar((_previo, carga) => carga);
    await tick();

    expect(refresh).not.toHaveBeenCalled();
    desmontar();
  });

  it("refresca cuando la acción devuelve un estado nuevo", async () => {
    const { disparar, texto, desmontar } = montar((_previo, carga) => carga);

    disparar("respuesta");

    await tick();

    expect(texto()).toBe("respuesta");
    expect(refresh).toHaveBeenCalledTimes(1);
    desmontar();
  });

  it("refresca una vez por respuesta, no una vez por render", async () => {
    const { disparar, desmontar } = montar((_previo, carga) => carga);

    disparar("uno");
    await tick();
    disparar("dos");
    await tick();

    expect(refresh).toHaveBeenCalledTimes(2);
    desmontar();
  });

  // Distinguir éxito de error exigiría conocer la forma del estado de cada
  // acción, que es justo el acoplamiento que este envoltorio evita. Refrescar
  // de más cuesta un fetch; refrescar de menos deja datos viejos en pantalla.
  it("refresca también cuando la respuesta es un rechazo", async () => {
    const { disparar, desmontar } = montar(() => "error: faltan datos");

    disparar("lo que sea");
    await tick();

    expect(refresh).toHaveBeenCalledTimes(1);
    desmontar();
  });

  it("no refresca si la acción devuelve el MISMO estado", async () => {
    const mismo = "sin cambios";
    const { disparar, desmontar } = montar(() => mismo);

    // El primer disparo cambia "inicial" -> "sin cambios"; el segundo devuelve
    // exactamente el mismo valor y no hay nada nuevo que mostrar.
    disparar("a");
    await tick();
    disparar("b");
    await tick();

    expect(refresh).toHaveBeenCalledTimes(1);
    desmontar();
  });
});

describe("useActionState del proyecto · sin App Router", () => {
  // `renderToStaticMarkup` no monta router, y `useRouter` lanza ahí. Un
  // formulario no puede reventar por no poder refrescar.
  it("renderiza igual cuando useRouter lanza", async () => {
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

// --------------------------------------------------------------------------
// Una fila de la cola monta VARIOS formularios —facturar, cancelar, entregar,
// cambiar estado—, así que una pantalla con doce filas tiene decenas de
// instancias. Cada `router.refresh()` vuelve a pedir el árbol ENTERO: sin
// agrupar, doce respuestas juntas pagaban doce veces el mismo árbol.
// --------------------------------------------------------------------------
describe("useActionState del proyecto · varios formularios en la pantalla", () => {
  it("agrupa en UN solo refresco las respuestas del mismo tick", async () => {
    const a = montar((_p: string, c: string) => c);
    const b = montar((_p: string, c: string) => c);
    const c = montar((_p: string, c2: string) => c2);

    a.disparar("uno");
    b.disparar("dos");
    c.disparar("tres");
    await tick();

    expect(refresh).toHaveBeenCalledTimes(1);

    a.desmontar();
    b.desmontar();
    c.desmontar();
  });

  it("vuelve a refrescar en la tanda siguiente", async () => {
    const a = montar((_p: string, c: string) => c);
    const b = montar((_p: string, c: string) => c);

    a.disparar("uno");
    b.disparar("dos");
    await tick();
    expect(refresh).toHaveBeenCalledTimes(1);

    a.disparar("tres");
    await tick();
    expect(refresh).toHaveBeenCalledTimes(2);

    a.desmontar();
    b.desmontar();
  });
});
