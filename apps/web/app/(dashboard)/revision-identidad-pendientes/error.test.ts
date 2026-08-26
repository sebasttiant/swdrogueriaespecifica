/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import RevisionIdentidadPendientesError from "./error";

afterEach(cleanup);

describe("RevisionIdentidadPendientesError", () => {
  it("explica el fallo sin exponer detalles internos y permite reintentar con el teclado", async () => {
    const reset = vi.fn();
    const user = userEvent.setup();

    render(
      createElement(RevisionIdentidadPendientesError, {
        error: new Error("postgresql://internal-host:5432/private"),
        reset,
      }),
    );

    expect(screen.getByText("No se pudo cargar la revisión de identidad.")).toBeTruthy();
    expect(screen.queryByText(/internal-host|postgresql|private/i)).toBeNull();

    await user.tab();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBe(document.activeElement);
    await user.keyboard("{Enter}");

    expect(reset).toHaveBeenCalledOnce();
  });
});
