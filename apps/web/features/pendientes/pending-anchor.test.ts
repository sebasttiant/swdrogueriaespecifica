import { describe, expect, it } from "vitest";

import { pendingAnchorId, pendingReviewHref, pendingReviewListHref } from "./pending-anchor";

// --------------------------------------------------------------------------
// El enlace y su destino, probados JUNTOS.
//
// El defecto que esto arregla no fue un enlace mal escrito: fue que el `href`
// y el `id` vivían en archivos distintos y nadie se enteró de que el ancla
// nunca había existido. Probar solo el enlace habría dejado pasar ese defecto
// exacto, así que lo que se verifica acá es la CORRESPONDENCIA.
// --------------------------------------------------------------------------

describe("enlace a un pendiente · el destino existe", () => {
  it("el fragmento del enlace es exactamente el id del ancla", () => {
    const href = pendingReviewHref("pend-42");
    const fragmento = href.slice(href.indexOf("#") + 1);

    expect(fragmento).toBe(pendingAnchorId("pend-42"));
  });

  it("apunta a Revisión, no a la pantalla de captura", () => {
    const href = pendingReviewHref("pend-42");

    expect(href.startsWith("/revision-pendientes#")).toBe(true);
    expect(href.startsWith("/pendientes")).toBe(false);
  });

  // El valor viejo era `?view=listado`, que no existe: los válidos son `lista`
  // y `detalle`. Funcionaba por caer en el default, no porque estuviera bien.
  it("no arrastra parámetros de vista inventados", () => {
    expect(pendingReviewHref("pend-42")).not.toContain("view=");
    expect(pendingReviewHref("pend-42")).not.toContain("listado");
  });

  it("dos pendientes distintos no comparten ancla", () => {
    expect(pendingAnchorId("a")).not.toBe(pendingAnchorId("b"));
  });

  it("el enlace de la barra no señala ninguna fila", () => {
    expect(pendingReviewListHref()).toBe("/revision-pendientes");
    expect(pendingReviewListHref()).not.toContain("#");
  });
});
