import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MissingSummary } from "./missing-summary";

function render(
  summary: Partial<{
    open: number;
    overdue: number;
    ordered: number;
    confirmed: number;
  }> = {},
): string {
  return renderToStaticMarkup(
    createElement(MissingSummary, {
      summary: {
        open: summary.open ?? 0,
        overdue: summary.overdue ?? 0,
        ordered: summary.ordered ?? 0,
        confirmed: summary.confirmed ?? 0,
      },
    }),
  );
}

describe("MissingSummary · compact chip strip", () => {
  it("renders the four operational counters", () => {
    const html = render({ open: 12, overdue: 3, ordered: 5, confirmed: 8 });

    expect(html).toContain("Abiertos");
    expect(html).toContain("Vencidos");
    expect(html).toContain("Pedidos");
    expect(html).toContain("Autorizados");
    // La terminología vieja no debe sobrevivir en la franja de indicadores.
    expect(html).not.toContain("OK gerencia");
    expect(html).toContain(">12<");
    expect(html).toContain(">3<");
    expect(html).toContain(">5<");
    expect(html).toContain(">8<");
  });

  // `/faltantes` es una cola operativa, no un tablero. Los tiles de texto 3xl se
  // comían la pantalla del celular antes del primer faltante accionable.
  it("renders no large summary tiles", () => {
    const html = render({ open: 12, overdue: 3 });

    expect(html).not.toContain("text-3xl");
    expect(html).not.toContain("text-2xl");
    expect(html).not.toContain("Resumen global</p>");
  });

  // Un cero no es una alarma: teñir "Vencidos: 0" de rojo entrena al operador a
  // ignorar el color, que es justo lo contrario de para qué está.
  it("tints the overdue chip only when something is actually overdue", () => {
    expect(render({ overdue: 2 })).toContain("text-danger");
    expect(render({ overdue: 0 })).not.toContain("text-danger");
  });
});
