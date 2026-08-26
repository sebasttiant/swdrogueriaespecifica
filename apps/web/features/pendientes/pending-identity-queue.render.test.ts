import { describe, expect, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PendingIdentityQueueRow } from "@/server/repositories/pending.repository";

import { PendingIdentityQueue } from "./pending-identity-queue";

function row(overrides: Partial<PendingIdentityQueueRow> = {}): PendingIdentityQueueRow {
  return {
    productId: "prod-1",
    productName: "Acetaminofén 500mg",
    productCode: "ACE-500",
    pendingCount: 3,
    ...overrides,
  };
}

function render(props: Parameters<typeof PendingIdentityQueue>[0]) {
  return renderToStaticMarkup(createElement(PendingIdentityQueue, props));
}

const pageHref = (cursor: string) => `/revision-identidad-pendientes?cursor=${cursor}`;

describe("PendingIdentityQueue · filas agrupadas", () => {
  it("muestra producto, código interno y cuántos pendientes vivos acumula", () => {
    const html = render({
      items: [row({ productName: "Ibuprofeno 400mg", productCode: "IBU-400", pendingCount: 7 })],
      nextCursor: null,
      pageHref,
    });

    expect(html).toContain("Ibuprofeno 400mg");
    expect(html).toContain("IBU-400");
    expect(html).toContain("7");
  });

  // La fila es UN producto con N pendientes, no N filas. Si el agrupado se
  // perdiera, la cola dejaría de priorizar y volvería a ser una lista plana.
  it("emite una fila por producto, no una por pendiente", () => {
    const html = render({
      items: [
        row({ productId: "p-1", pendingCount: 9 }),
        row({ productId: "p-2", productName: "Otro", productCode: "OTR", pendingCount: 4 }),
      ],
      nextCursor: null,
      pageHref,
    });

    expect(html.match(/<tr/g)).toHaveLength(3); // encabezado + dos filas
  });

  // El orden lo decide el repositorio (cantidad DESC, id ASC). Reordenar acá
  // sería una segunda opinión sobre la prioridad, y las dos se separarían.
  it("respeta el orden recibido sin reordenar", () => {
    const html = render({
      items: [
        // Las cantidades van DESC como las manda el repositorio: un orden que
        // no coincide con ningún criterio que la UI pudiera inventar por su
        // cuenta, así que cualquier `sort` acá cambia el resultado.
        row({ productId: "p-1", productName: "Primero", pendingCount: 8 }),
        row({ productId: "p-2", productName: "Segundo", pendingCount: 2 }),
      ],
      nextCursor: null,
      pageHref,
    });

    expect(html.indexOf("Primero")).toBeLessThan(html.indexOf("Segundo"));
  });
});

describe("PendingIdentityQueue · paginación", () => {
  // El cursor viaja OPACO: la UI no lo parsea, no lo compara y no lo arma.
  it("pasa el cursor siguiente tal cual, sin reinterpretarlo", () => {
    // Lleva `:`, `/`, `+` y `%` a propósito: cualquier `split`, `slice` o
    // `decodeURIComponent` que la UI le aplicara devolvería algo distinto.
    const opaque = "7:prod-1/+op%20aco==";
    let received: string | null = null;

    render({
      items: [row()],
      nextCursor: opaque,
      pageHref: (cursor) => {
        received = cursor;
        return "/href";
      },
    });

    expect(received).toBe(opaque);
  });

  it("no ofrece página siguiente cuando el cursor es null", () => {
    const html = render({ items: [row()], nextCursor: null, pageHref });

    expect(html).not.toContain("Ver más");
  });

  it("ofrece un enlace navegable por teclado a la página siguiente", () => {
    const html = render({ items: [row()], nextCursor: "abc", pageHref });

    expect(html).toContain("Ver más");
    expect(html).toContain('href="/revision-identidad-pendientes?cursor=abc"');
  });
});

describe("PendingIdentityQueue · estado vacío y accesibilidad", () => {
  it("dice que no queda nada por vincular en vez de mostrar una tabla vacía", () => {
    const html = render({ items: [], nextCursor: null, pageHref });

    expect(html).not.toContain("<table");
    expect(html).toContain("Sin identidades pendientes");
  });

  // Una tabla de datos sin encabezados de columna anunciados es ilegible con
  // lector de pantalla: cada celda se lee suelta, sin decir de qué columna es.
  it("declara encabezados de columna y un resumen para lector de pantalla", () => {
    const html = render({ items: [row()], nextCursor: null, pageHref });

    expect(html.match(/scope="col"/g)).toHaveLength(3);
    expect(html).toContain("<caption");
  });
});
