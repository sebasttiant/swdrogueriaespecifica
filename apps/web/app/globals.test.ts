import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("print theme tokens", () => {
  it("restores the light warning foreground for dark-theme print output", async () => {
    const css = await readFile(new URL("./globals.css", import.meta.url), "utf8");
    const printStyles = css.slice(css.indexOf("@media print {"));
    const darkPrintTokens = printStyles.match(/\[data-theme="dark"]\s*\{(?<tokens>[^}]*)}/);

    expect(darkPrintTokens?.groups?.tokens).toContain("--color-warning-foreground: #3a2a00;");
  });
});
