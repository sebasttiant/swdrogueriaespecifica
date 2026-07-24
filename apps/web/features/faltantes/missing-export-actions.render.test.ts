import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MissingExportActions } from "./missing-export-actions";

const html = () => renderToStaticMarkup(createElement(MissingExportActions));

describe("MissingExportActions", () => {
  it("offers the three export formats", () => {
    const out = html();

    expect(out).toContain("Descargar PDF");
    expect(out).toContain("Descargar Excel");
    expect(out).toContain("Descargar CSV");
  });

  // Excel y CSV pasan por la ruta de servidor (Content-Disposition, iOS-friendly),
  // no por un blob del cliente.
  it("links Excel and CSV to the server export route", () => {
    const out = html();

    expect(out).toContain('href="/faltantes/export?format=xlsx"');
    expect(out).toContain('href="/faltantes/export?format=csv"');
  });

  it("hides itself when printing so it never lands in the PDF", () => {
    expect(html()).toContain("print:hidden");
  });
});
