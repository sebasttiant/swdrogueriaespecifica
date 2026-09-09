import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { rootClassTokens } from "@/lib/testing/class-tokens";

// Se llama al componente COMO FUNCIÓN, no vía `createElement`, y no es
// capricho: `AlertProps` declara `children` REQUERIDO —una alerta vacía es un
// defecto, no un caso de uso— y con esa firma `createElement(Alert, props,
// hijos)` no typechequea, porque los hijos variádicos no satisfacen la prop.
// Pasarlos dentro del objeto typechequea pero lo prohíbe `react/no-children-prop`.
// La llamada directa sale de la pinza sin debilitar el contrato del componente,
// y ya es la convención de `alert-bar-severity.test.ts` con `AlertBar`.

import { Alert } from "./alert";

// --------------------------------------------------------------------------
// El tono `danger` pasa de tinte (`bg-danger/10` + `text-danger`) a relleno
// pleno (`bg-danger-solid` + `text-danger-solid-foreground`): el tinte no
// cumplía AA en ningún tema (ver `globals.test.ts`, par `--color-danger-solid`).
// Los demás tonos NO se tocan: es jerarquía deliberada, no un arreglo parejo.
// --------------------------------------------------------------------------
describe("Alert", () => {
  it("paints the danger tone as a solid fill, not a tint", () => {
    const html = renderToStaticMarkup(Alert({ tone: "danger", children: "Peligro" }));
    const clases = rootClassTokens(html);

    expect(clases).toContain("bg-danger-solid");
    expect(clases).toContain("text-danger-solid-foreground");
    expect(clases).toContain("border-danger-solid");

    // El tinte viejo NO puede quedar. Se compara clase contra clase y no por
    // subcadena: `text-danger` es prefijo de `text-danger-solid-foreground`,
    // y la guarda anterior —`not.toMatch(/\btext-danger\b/)`— matcheaba
    // justamente la clase que venía a distinguir, porque en una regex el
    // guion es un BORDE de palabra, no un carácter de palabra.
    expect(clases).not.toContain("bg-danger/10");
    expect(clases).not.toContain("border-danger/30");
    expect(clases).not.toContain("text-danger");
  });

  // Guarda de jerarquía: si todos los tonos gritan, ninguno grita. Ver el
  // mismo razonamiento en `waitlist.ts` sobre por qué AGOTADO queda afuera de
  // la alerta roja.
  it("keeps warning, success and neutral tones as tints", () => {
    const warning = renderToStaticMarkup(Alert({ tone: "warning", children: "Aviso" }));
    const success = renderToStaticMarkup(Alert({ tone: "success", children: "Éxito" }));
    const neutral = renderToStaticMarkup(Alert({ tone: "neutral", children: "Info" }));

    expect(warning).toContain("bg-warning/10");
    expect(warning).toContain("border-warning/30");
    expect(success).toContain("bg-success/10");
    expect(success).toContain("border-success/30");
    expect(neutral).toContain("bg-muted");
  });
});
