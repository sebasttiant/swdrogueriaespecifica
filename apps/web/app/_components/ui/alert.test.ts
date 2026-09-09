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
// El tono `danger` es un ACENTO —filo rojo sobre superficie normal—, no un
// relleno. Fue relleno pleno y se comía la pantalla; antes fue tinte y no
// cumplía AA. El rojo no se desaturó: se le redujo el ÁREA. Ver el comentario
// de `TONE_CLASSES` y `globals.test.ts` para las mediciones.
//
// Los demás tonos NO se tocan: es jerarquía deliberada, no un arreglo parejo.
// --------------------------------------------------------------------------
describe("Alert", () => {
  it("marks the danger tone with an accent, not with a filled surface", () => {
    const html = renderToStaticMarkup(Alert({ tone: "danger", children: "Peligro" }));
    const clases = rootClassTokens(html);

    // El rojo entero, en un filo de 4 px: superficie normal y texto normal.
    expect(clases).toContain("border-l-4");
    expect(clases).toContain("border-l-danger");
    expect(clases).toContain("bg-surface");
    expect(clases).toContain("text-text");

    // Ni el bloque pleno que se comía la pantalla, ni el tinte que no cumplía
    // AA. Se compara clase contra clase y no por subcadena: `text-danger` es
    // prefijo de `text-danger-solid-foreground`, y una guarda con
    // `/\btext-danger\b/` matcheaba justo la clase que venía a distinguir,
    // porque en una regex el guion es un BORDE de palabra.
    expect(clases).not.toContain("bg-danger-solid");
    expect(clases).not.toContain("bg-danger/10");
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
