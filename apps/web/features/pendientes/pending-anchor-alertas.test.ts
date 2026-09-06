import { describe, expect, it } from "vitest";

import {
  pendingDeadlineHref,
  pendingReviewListHref,
  supplyOverdueHref,
} from "./pending-anchor";
import { DEADLINE_AXIS_VALUES } from "./review-axes";

// --------------------------------------------------------------------------
// La barra de avisos NUNCA manda a la pantalla de captura.
//
// `/pendientes` arranca con el formulario de "Nuevo pendiente" y `/faltantes`
// con el de reportar uno. Quien toca un aviso viene a resolver algo que YA
// existe. Es el mismo defecto que ya se arregló con el aviso de llegada, y
// volvió a aparecer en los chips.
// --------------------------------------------------------------------------

const CAPTURE_SCREENS = ["/pendientes", "/faltantes"];

describe("enlaces de los chips", () => {
  it.each(DEADLINE_AXIS_VALUES)("%s abre seguimiento con su ventana", (window) => {
    expect(pendingDeadlineHref(window)).toBe(
      `/revision-pendientes?entrega=${window}`,
    );
  });

  it("los faltantes vencidos abren abastecimiento, ya filtrado", () => {
    expect(supplyOverdueHref()).toBe(
      "/revision-pendientes?tab=abastecimiento&entrega=atrasadas",
    );
  });

  // La regresión, escrita como regla y no como caso: ningún enlace de la barra
  // puede tener como RUTA una pantalla de captura.
  it.each([
    pendingReviewListHref(),
    pendingDeadlineHref("atrasadas"),
    pendingDeadlineHref("proximas"),
    supplyOverdueHref(),
  ])("%s no cae en una pantalla de captura", (href) => {
    const path = href.split("?")[0];
    expect(CAPTURE_SCREENS).not.toContain(path);
  });

  // Un chip promete un número. Si el destino llega sin filtrar, la persona
  // igual tiene que buscar sus 4 entre 40 y el aviso no sirvió de nada.
  it.each([
    pendingDeadlineHref("atrasadas"),
    pendingDeadlineHref("proximas"),
    supplyOverdueHref(),
  ])("%s llega filtrado, no a la lista completa", (href) => {
    expect(new URLSearchParams(href.split("?")[1]).get("entrega")).toBeTruthy();
  });
});
