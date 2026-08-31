import { describe, expect, it } from "vitest";

import {
  FOCUS_PARAM,
  pendingAnchorId,
  pendingReviewHref,
  pendingReviewListHref,
  resolveFocusedPendingId,
} from "./pending-anchor";

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

    expect(href.startsWith("/revision-pendientes?")).toBe(true);
    expect(href.startsWith("/pendientes")).toBe(false);
  });

  // El fragmento de una URL NUNCA llega al servidor. Con la lista paginada de a
  // 20, un ancla sola alcanza únicamente si el pendiente cayó en la primera
  // página: para uno más viejo el servidor no puede saber que hacía falta, no
  // lo renderiza, y el enlace vuelve a no hacer nada. Por eso el id viaja dos
  // veces, y esta prueba fija que las dos copias coincidan.
  it("el id viaja también en la query, que sí llega al servidor", () => {
    const href = pendingReviewHref("pend-42");
    const url = new URL(href, "https://ejemplo.test");

    expect(url.searchParams.get(FOCUS_PARAM)).toBe("pend-42");
    expect(url.hash).toBe(`#${pendingAnchorId("pend-42")}`);
  });

  it("la query y el fragmento nombran al MISMO pendiente", () => {
    const url = new URL(pendingReviewHref("abc123"), "https://ejemplo.test");

    expect(url.hash).toBe(`#${pendingAnchorId(url.searchParams.get(FOCUS_PARAM)!)}`);
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

// --------------------------------------------------------------------------
// `?focus=` es entrada de usuario y termina en una consulta.
//
// El recorte por dueño manda igual del lado del servicio —esta es la primera
// puerta, no la única—, pero descartar temprano lo que ni siquiera tiene forma
// de id evita consultar por basura en cada carga de la pantalla.
// --------------------------------------------------------------------------
describe("resolveFocusedPendingId · qué se acepta de la URL", () => {
  it("acepta un id con la forma que genera la aplicación", () => {
    const id = "cm3x8k2p90000abcd1234efgh";
    expect(resolveFocusedPendingId(id)).toBe(id);
  });

  it("recorta espacios", () => {
    const id = "cm3x8k2p90000abcd1234efgh";
    expect(resolveFocusedPendingId(`  ${id}  `)).toBe(id);
  });

  it("descarta lo que no está", () => {
    expect(resolveFocusedPendingId(undefined)).toBeNull();
    expect(resolveFocusedPendingId(null)).toBeNull();
    expect(resolveFocusedPendingId("")).toBeNull();
    expect(resolveFocusedPendingId("   ")).toBeNull();
  });

  it("descarta lo que no tiene forma de id", () => {
    for (const basura of [
      "../../etc/passwd",
      "1 OR 1=1",
      "<script>alert(1)</script>",
      "corto",
      "con espacios adentro aaaaaaaaaaaaaaa",
      "a".repeat(200),
    ]) {
      expect(resolveFocusedPendingId(basura), basura).toBeNull();
    }
  });

  // Lo que se acepta tiene que poder volver a armar el enlace: si la validación
  // rechazara ids válidos, el destacado no funcionaría nunca.
  it("lo que acepta sirve para armar el enlace de vuelta", () => {
    const id = "cm3x8k2p90000abcd1234efgh";
    const url = new URL(pendingReviewHref(id), "https://ejemplo.test");

    expect(resolveFocusedPendingId(url.searchParams.get(FOCUS_PARAM))).toBe(id);
  });
});
