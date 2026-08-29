/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/deployment/app-version", async (original) => {
  const actual = await original<typeof import("@/lib/deployment/app-version")>();
  return { ...actual, APP_VERSION: "build-viejo" };
});

import { DeploymentGuard } from "./deployment-guard";

// --------------------------------------------------------------------------
// La pestaña que quedó abierta durante un despliegue.
//
// Sus Server Actions ya no existen del otro lado: el servidor responde "Failed
// to find Server Action" y el botón se queda girando. Desde el mostrador eso se
// lee como que la aplicación se colgó, y lo que sigue es alguien apretando
// Facturar otra vez.
// --------------------------------------------------------------------------

const CHECK_MS = 60_000;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function serverResponds(version: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ version }),
  });
}

const banner = () => screen.queryByRole("alert");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("DeploymentGuard · detección", () => {
  // CASO A — misma versión, nada que avisar.
  it("no avisa cuando el servidor sirve el mismo build", async () => {
    vi.stubGlobal("fetch", serverResponds("build-viejo"));
    render(createElement(DeploymentGuard, null, "contenido"));

    await vi.advanceTimersByTimeAsync(CHECK_MS);

    expect(banner()).toBeNull();
  });

  // CASO B — cliente v1, servidor v2.
  it("avisa cuando el servidor cambió de build", async () => {
    vi.stubGlobal("fetch", serverResponds("build-nuevo"));
    render(createElement(DeploymentGuard, null, "contenido"));

    await vi.advanceTimersByTimeAsync(CHECK_MS);

    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()?.textContent).toContain("nueva versión disponible");
  });

  it("no consulta al montar: el aviso aparece recién al detectar", () => {
    const fetchMock = serverResponds("build-nuevo");
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(DeploymentGuard, null, "contenido"));

    expect(banner()).toBeNull();
  });
});

describe("DeploymentGuard · disciplina del sondeo", () => {
  // CASO D
  it("no consulta con la pestaña oculta", async () => {
    const fetchMock = serverResponds("build-nuevo");
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(DeploymentGuard, null, "x"));
    setVisibility("hidden");

    await vi.advanceTimersByTimeAsync(CHECK_MS * 3);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // CASO E — volver a la pestaña es el momento más probable de haberse perdido
  // un despliegue.
  it("consulta apenas la pestaña vuelve a ser visible", async () => {
    const fetchMock = serverResponds("build-nuevo");
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(DeploymentGuard, null, "x"));
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(fetchMock).not.toHaveBeenCalled();

    setVisibility("visible");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("consulta al recuperar el foco de la ventana", async () => {
    const fetchMock = serverResponds("build-viejo");
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(DeploymentGuard, null, "x"));

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  // CASO F
  it("no encima consultas", async () => {
    const pendiente: { resolver: ((v: unknown) => void) | null } = { resolver: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((r) => { pendiente.resolver = r; })),
    );
    render(createElement(DeploymentGuard, null, "x"));

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(CHECK_MS * 2);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    pendiente.resolver?.({ ok: true, json: async () => ({ version: "x" }) });
  });

  // CASO G
  it("suelta timer y listeners al desmontar", async () => {
    const fetchMock = serverResponds("build-nuevo");
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(createElement(DeploymentGuard, null, "x"));
    unmount();

    await vi.advanceTimersByTimeAsync(CHECK_MS * 3);
    window.dispatchEvent(new Event("focus"));
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DeploymentGuard · errores de red", () => {
  // CASO H — sin conexión no hay evidencia de que el servidor cambió, y
  // bloquear las mutaciones por esa duda dejaría al mostrador sin facturar.
  it("un fallo de red NO marca desfase", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("sin red")));
    render(createElement(DeploymentGuard, null, "x"));

    await vi.advanceTimersByTimeAsync(CHECK_MS);

    expect(banner()).toBeNull();
  });

  it("una respuesta no-ok tampoco marca desfase", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(createElement(DeploymentGuard, null, "x"));

    await vi.advanceTimersByTimeAsync(CHECK_MS);

    expect(banner()).toBeNull();
  });

  it("vuelve a intentar en el turno siguiente", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("sin red"))
      .mockResolvedValue({ ok: true, json: async () => ({ version: "build-nuevo" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(DeploymentGuard, null, "x"));

    await vi.advanceTimersByTimeAsync(CHECK_MS);
    await vi.advanceTimersByTimeAsync(CHECK_MS);

    await waitFor(() => expect(banner()).not.toBeNull());
  });
});

describe("DeploymentGuard · actualizar", () => {
  // CASO C — una recarga, y solo cuando la persona la pide.
  it("recarga una sola vez al apretar el botón", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload },
    });
    vi.stubGlobal("fetch", serverResponds("build-nuevo"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(createElement(DeploymentGuard, null, "x"));
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    await waitFor(() => expect(banner()).not.toBeNull());

    await user.click(screen.getByRole("button", { name: /Actualizar ahora/i }));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("NO recarga por su cuenta al detectar el desfase", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload },
    });
    vi.stubGlobal("fetch", serverResponds("build-nuevo"));
    render(createElement(DeploymentGuard, null, "x"));

    await vi.advanceTimersByTimeAsync(CHECK_MS * 3);

    expect(reload).not.toHaveBeenCalled();
  });
});
