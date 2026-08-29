/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listArrivalNoticesAction: vi.fn(),
  refresh: vi.fn(),
}));

// Se mockea para PROBAR que NUNCA se llama. Recargar la ruta entera cada quince
// segundos volvería a pedir el formulario, los filtros y el listado completo
// para actualizar un cartel de dos líneas — por cada vendedor conectado.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@/server/actions/arrival-notice.actions", () => ({
  listArrivalNoticesAction: mocks.listArrivalNoticesAction,
}));

import { ArrivalNoticesLive } from "./arrival-notices-live";

// --------------------------------------------------------------------------
// El sondeo existe para UN caso: bodega registra la entrada desde otra sesión y
// el vendedor está mirando Pendientes sin tocar nada. Ningún refresco disparado
// por sus propias acciones puede enterarse de eso — está esperando, no operando.
//
// Todo lo que se prueba acá es la disciplina del ciclo, que es donde un sondeo
// mal hecho se convierte en carga: no consultar con la pestaña oculta, no
// encimar peticiones, no romper la pantalla ante un error pasajero, y soltar
// todo al desmontar.
// --------------------------------------------------------------------------

const POLL_MS = 15_000;

function notice(over: Record<string, unknown> = {}) {
  return {
    pendingId: "pend-1",
    productName: "Amoxicilina",
    quantity: 3,
    readyQuantity: 3,
    availabilityStatus: "DISPONIBLE_COMPLETO" as const,
    customerName: null,
    noticedAt: Date.UTC(2026, 7, 28, 12, 0, 0),
    ...over,
  };
}

/** jsdom no deja escribir `visibilityState` directamente. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function renderLive(initial: ReturnType<typeof notice>[] = []) {
  return render(
    createElement(ArrivalNoticesLive, {
      initialNotices: initial.map((n) => ({ ...n, noticedAt: new Date(n.noticedAt) })),
      canViewCustomerIdentity: true,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setVisibility("visible");
  mocks.listArrivalNoticesAction.mockResolvedValue({ ok: true, notices: [] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("ArrivalNoticesLive · lo que llega desde otra sesión", () => {
  // CASO G — el aviso aparece sin que la persona toque nada.
  it("muestra un aviso nuevo sin recargar ni intervención", async () => {
    renderLive([]);
    expect(screen.queryByText(/Ya llegó/)).toBeNull();

    mocks.listArrivalNoticesAction.mockResolvedValue({
      ok: true,
      notices: [notice({ productName: "Losartán 50mg" })],
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);

    await waitFor(() => expect(screen.getByText(/Losartán 50mg/)).toBeDefined());
  });

  it("arranca con lo que el servidor ya había renderizado", () => {
    renderLive([notice({ productName: "Ibuprofeno" })]);

    expect(screen.getByText(/Ibuprofeno/)).toBeDefined();
    expect(mocks.listArrivalNoticesAction).not.toHaveBeenCalled();
  });
});

describe("ArrivalNoticesLive · disciplina del ciclo", () => {
  // CASO H — con la pestaña oculta no se consulta.
  it("no consulta mientras la pestaña está oculta", async () => {
    renderLive();
    setVisibility("hidden");

    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(mocks.listArrivalNoticesAction).not.toHaveBeenCalled();
  });

  // CASO I — al volver, consulta YA. La persona vuelve justamente a mirar.
  it("consulta de inmediato al volver a ser visible", async () => {
    renderLive();
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(mocks.listArrivalNoticesAction).not.toHaveBeenCalled();

    setVisibility("visible");

    await waitFor(() =>
      expect(mocks.listArrivalNoticesAction).toHaveBeenCalledTimes(1),
    );
  });

  // CASO J — nunca dos en vuelo.
  it("no encima peticiones cuando la anterior sigue viva", async () => {
    // TS pierde el tipo de `resolver` al asignarlo dentro del callback; el
    // objeto lo mantiene explícito sin apagar el chequeo.
    const pendiente: { resolver: ((v: unknown) => void) | null } = { resolver: null };
    mocks.listArrivalNoticesAction.mockImplementation(
      () => new Promise((r) => { pendiente.resolver = r; }),
    );

    renderLive();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(mocks.listArrivalNoticesAction).toHaveBeenCalledTimes(1);
    pendiente.resolver?.({ ok: true, notices: [] });
  });

  // CASO K — al desmontar no queda nada corriendo.
  it("suelta el timer al desmontar", async () => {
    const { unmount } = renderLive();
    unmount();

    await vi.advanceTimersByTimeAsync(POLL_MS * 4);

    expect(mocks.listArrivalNoticesAction).not.toHaveBeenCalled();
  });

  it("suelta el listener de visibilidad al desmontar", async () => {
    const { unmount } = renderLive();
    unmount();

    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.listArrivalNoticesAction).not.toHaveBeenCalled();
  });
});

describe("ArrivalNoticesLive · errores pasajeros", () => {
  // CASO L — un fallo NO puede vaciar la pantalla. Hacerlo le haría creer al
  // vendedor que el pedido dejó de estar listo.
  it("conserva los avisos cuando la consulta falla", async () => {
    renderLive([notice({ productName: "Paracetamol" })]);
    mocks.listArrivalNoticesAction.mockResolvedValue({ ok: false });

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(screen.getByText(/Paracetamol/)).toBeDefined();
  });

  it("conserva los avisos cuando la consulta lanza", async () => {
    renderLive([notice({ productName: "Paracetamol" })]);
    mocks.listArrivalNoticesAction.mockRejectedValue(new Error("red caída"));

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(screen.getByText(/Paracetamol/)).toBeDefined();
  });

  it("vuelve a intentar en el turno siguiente", async () => {
    renderLive();
    mocks.listArrivalNoticesAction.mockRejectedValueOnce(new Error("red caída"));

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(mocks.listArrivalNoticesAction).toHaveBeenCalledTimes(2);
  });
});

// --------------------------------------------------------------------------
// El ciclo se encadena: el turno siguiente se agenda cuando el anterior cerró,
// no cada quince segundos pase lo que pase. Con la red lenta, un intervalo
// ciego acumula turnos sobre una petición que todavía no volvió.
// --------------------------------------------------------------------------
describe("ArrivalNoticesLive · el ciclo se encadena", () => {
  // CASO G
  it("no agenda el turno siguiente hasta terminar el actual", async () => {
    const enVuelo: { resolver: ((v: unknown) => void) | null } = { resolver: null };
    mocks.listArrivalNoticesAction.mockImplementation(
      () => new Promise((r) => { enVuelo.resolver = r; }),
    );
    renderLive();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(mocks.listArrivalNoticesAction).toHaveBeenCalledTimes(1);

    // Pasan varios turnos con la respuesta colgada: ninguno dispara nada.
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(mocks.listArrivalNoticesAction).toHaveBeenCalledTimes(1);

    // Recién al cerrar, el ciclo sigue.
    enVuelo.resolver?.({ ok: true, notices: [] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(mocks.listArrivalNoticesAction).toHaveBeenCalledTimes(2);
  });

  // CASO M — un rerender del padre no puede dejar dos ciclos corriendo.
  it("un rerender no multiplica los ciclos", async () => {
    const { rerender } = renderLive();

    for (let i = 0; i < 4; i += 1) {
      rerender(
        createElement(ArrivalNoticesLive, {
          initialNotices: [],
          canViewCustomerIdentity: true,
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(mocks.listArrivalNoticesAction).toHaveBeenCalledTimes(1);
  });
});

describe("ArrivalNoticesLive · lo que NO hace", () => {
  // CASO I — escribir estado después de desmontar es la fuga que React avisa,
  // y acá además sería pintar datos de una pantalla que la persona ya dejó.
  it("una respuesta que llega después de desmontar no rompe nada", async () => {
    const enVuelo: { resolver: ((v: unknown) => void) | null } = { resolver: null };
    mocks.listArrivalNoticesAction.mockImplementation(
      () => new Promise((r) => { enVuelo.resolver = r; }),
    );
    const { unmount } = renderLive();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    unmount();
    enVuelo.resolver?.({ ok: true, notices: [notice({ productName: "Tarde" })] });

    await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();
    expect(screen.queryByText(/Tarde/)).toBeNull();
  });

  // CASO L — prueba de COMPORTAMIENTO: se ejecutan los ciclos y se comprueba
  // que `refresh` no se llamó nunca. Buscar texto en el archivo demuestra que
  // la vía no existe hoy, pero no que no se use; esto demuestra lo segundo.
  it("nunca llama a router.refresh, ni con respuestas nuevas", async () => {
    renderLive([notice({ productName: "Inicial" })]);
    mocks.listArrivalNoticesAction.mockResolvedValue({
      ok: true,
      notices: [notice({ pendingId: "p-9", productName: "Recién llegado" })],
    });

    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    window.dispatchEvent(new Event("focus"));
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(POLL_MS);

    await waitFor(() => expect(screen.getByText(/Recién llegado/)).toBeDefined());
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  // Complemento estático: además de no usarlo, no existe la vía.
  it("tampoco importa el router", async () => {
    const { readFileSync } = await import("node:fs");
    const codigo = readFileSync(
      "features/pendientes/arrival-notices-live.tsx",
      "utf8",
    )
      // Sin comentarios: los de este componente EXPLICAN por qué no se usa el
      // router, y mencionarlo ahí no puede contar como usarlo.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");

    expect(codigo).not.toMatch(/from "next\/navigation"/);
    expect(codigo).not.toMatch(/useRouter/);
  });
});

describe("ArrivalNoticesLive · solo toca los avisos", () => {
  // CASO K
  it("reemplaza los avisos y nada más", async () => {
    renderLive([notice({ productName: "Viejo" })]);
    mocks.listArrivalNoticesAction.mockResolvedValue({
      ok: true,
      notices: [notice({ pendingId: "p-2", productName: "Nuevo" })],
    });

    await vi.advanceTimersByTimeAsync(POLL_MS);

    await waitFor(() => expect(screen.getByText(/Nuevo/)).toBeDefined());
    expect(screen.queryByText(/Viejo/)).toBeNull();
  });
});
