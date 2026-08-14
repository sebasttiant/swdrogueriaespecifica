import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Badge } from "./badge";

describe("Badge", () => {
  it("uses a fixed radius and vertical padding for multiline labels", () => {
    const html = renderToStaticMarkup(
      createElement(Badge, { tone: "warning" }, "Cargado: 2 de 5 · podés facturar"),
    );

    expect(html).toContain("rounded-lg");
    expect(html).toContain("py-1");
    expect(html).not.toContain("rounded-full");
  });
});
