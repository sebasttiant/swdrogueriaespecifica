import { describe, expect, it } from "vitest";

import {
  MAX_REVIEW_QUEUE_PAGE,
  parseReportQueuePage,
  reportQueueHref,
  REVIEW_QUEUE_PATH,
} from "./report-queue-paging";

describe("parseReportQueuePage", () => {
  it("defaults to the first page when the param is absent", () => {
    expect(parseReportQueuePage(undefined)).toBe(1);
  });

  // El número de página viene de la URL: cualquier basura cae en la página 1 en
  // vez de propagar un offset negativo o NaN a la consulta.
  it("falls back to the first page for junk, zero or negative values", () => {
    expect(parseReportQueuePage("")).toBe(1);
    expect(parseReportQueuePage("abc")).toBe(1);
    expect(parseReportQueuePage("0")).toBe(1);
    expect(parseReportQueuePage("-4")).toBe(1);
    expect(parseReportQueuePage("NaN")).toBe(1);
    expect(parseReportQueuePage("Infinity")).toBe(1);
  });

  it("reads a valid page number", () => {
    expect(parseReportQueuePage("1")).toBe(1);
    expect(parseReportQueuePage("7")).toBe(7);
  });

  it("truncates a decimal page to an integer", () => {
    expect(parseReportQueuePage("2.9")).toBe(2);
  });

  // Un número de página enorme se traduce en un OFFSET enorme. La cola es
  // admin-only y acotada en `take`, pero un scan gratuito es evitable: se topea.
  it("caps an absurd page number instead of producing a huge offset", () => {
    expect(parseReportQueuePage("999999999999")).toBe(MAX_REVIEW_QUEUE_PAGE);
    expect(parseReportQueuePage(String(MAX_REVIEW_QUEUE_PAGE + 1))).toBe(
      MAX_REVIEW_QUEUE_PAGE,
    );
    expect(parseReportQueuePage(String(MAX_REVIEW_QUEUE_PAGE))).toBe(
      MAX_REVIEW_QUEUE_PAGE,
    );
  });
});

describe("reportQueueHref", () => {
  // La primera página vive en la URL limpia: no se ensucia con ?page=1.
  it("keeps the first page on the bare path", () => {
    expect(reportQueueHref(1)).toBe(REVIEW_QUEUE_PATH);
  });

  it("names any other page in the query string", () => {
    expect(reportQueueHref(2)).toBe(`${REVIEW_QUEUE_PATH}?page=2`);
    expect(reportQueueHref(11)).toBe(`${REVIEW_QUEUE_PATH}?page=11`);
  });

  // Nunca se construye un link a una página inexistente: el helper acota.
  it("never builds a link below the first page", () => {
    expect(reportQueueHref(0)).toBe(REVIEW_QUEUE_PATH);
    expect(reportQueueHref(-3)).toBe(REVIEW_QUEUE_PATH);
  });

  it("points at the review queue route, separate from /faltantes", () => {
    expect(REVIEW_QUEUE_PATH).toBe("/revision-faltantes");
    // La cola pagina por offset; /faltantes pagina por cursor. Rutas distintas
    // justamente para que los dos parámetros no convivan en la misma URL.
    expect(reportQueueHref(2)).not.toContain("cursor");
  });
});
