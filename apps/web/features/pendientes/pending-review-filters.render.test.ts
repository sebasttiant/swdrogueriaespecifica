import { describe, expect, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PendingReviewFilters } from "./pending-review-filters";
import type { ReviewAxes } from "./review-axes";

function render(
  props: Partial<{
    axes: ReviewAxes;
    scope: "active" | "history";
    view: "lista" | "detalle";
    readyToInvoiceCount: number;
  }> = {},
): string {
  return renderToStaticMarkup(
    createElement(PendingReviewFilters, {
      axes: props.axes ?? {},
      scope: props.scope ?? "active",
      view: props.view ?? "lista",
      readyToInvoiceCount: props.readyToInvoiceCount,
    }),
  );
}

// --------------------------------------------------------------------------
// "Listos para facturar" vive dentro de los filtros de siempre, pero SOLO en
// Revisión de pendientes: esa página pasa el contador. `/pendientes` comparte
// este componente y no lo pasa, así que tiene que quedar exactamente igual.
// --------------------------------------------------------------------------
describe("PendingReviewFilters · listos para facturar", () => {
  it("no aparece cuando la página no pasa el contador", () => {
    const html = render();

    expect(html).not.toContain("Listos para facturar");
    expect(html).not.toContain("facturar=listos");
  });

  it("aparece con su contador cuando la página lo pasa", () => {
    const html = render({ readyToInvoiceCount: 7 });

    expect(html).toContain("Listos para facturar");
    expect(html).toMatch(/<span class="[^"]*tabular-nums[^"]*">\(7\)<\/span>/);
    expect(html).toContain("facturar=listos");
  });

  it("muestra el cero: también es una respuesta", () => {
    expect(render({ readyToInvoiceCount: 0 })).toContain("(0)");
  });

  it("se combina con la entrega en vez de reemplazarla", () => {
    const html = render({ axes: { deadline: "atrasadas" }, readyToInvoiceCount: 2 });

    expect(html).toContain("entrega=atrasadas&amp;facturar=listos");
  });

  it("marca el chip activo y ofrece quitar filtros", () => {
    const html = render({ axes: { invoice: "listos" }, readyToInvoiceCount: 2 });

    expect(html).toMatch(/aria-current="true"[^>]*>Listos para facturar/);
    expect(html).toContain("Quitar filtros");
  });
});

describe("PendingReviewFilters", () => {
  it("ofrece los tres ejes", () => {
    const html = render();

    expect(html).toContain("Compras");
    expect(html).toContain("Disponibilidad");
    expect(html).toContain("Cliente");
  });

  // El rol sale de la sesión. Un desplegable de rol en pantalla dejaría que
  // cualquiera se asigne el suyo y viera lo que no le toca.
  //
  // Ojo con buscar "BODEGA" suelto: aparece dentro de LLEGO_BODEGA, que es un
  // valor del eje de disponibilidad y no tiene nada que ver con el rol.
  it("no ofrece ningún selector de rol", () => {
    const html = render();

    expect(html).not.toContain("<select");
    expect(html).not.toContain("Rol");
    expect(html).not.toContain("Gestión");
    expect(html).not.toContain("Vendedor");
    // Ningún enlace propone cambiar de rol.
    expect(html).not.toContain("role=");
  });

  it("marca como activa la opción elegida de cada eje", () => {
    const html = render({ axes: { purchase: "AGOTADO" } });

    expect(html).toContain('aria-current="true"');
    expect(html).toContain("purchase=AGOTADO");
  });

  // Elegir en un eje no puede borrar lo que ya se eligió en otro: son
  // independientes y se combinan.
  it("conserva los otros ejes al cambiar uno", () => {
    const html = render({ axes: { customer: "CONTACTADO" } });

    expect(html).toContain("purchase=SOLICITADO&amp;customer=CONTACTADO");
  });

  it("arrastra el scope y la vista en cada opción", () => {
    const html = render({ scope: "history", view: "detalle" });

    expect(html).toContain("scope=history");
    expect(html).toContain("view=detalle");
  });

  // Con tres ejes es fácil quedarse en una lista vacía sin entender por qué. La
  // salida tiene que estar a la vista, no depender de editar la URL.
  it("ofrece quitar los filtros solo cuando hay alguno puesto", () => {
    expect(render()).not.toContain("Quitar filtros");
    expect(render({ axes: { purchase: "BUSQUEDA" } })).toContain("Quitar filtros");
  });

  it("nunca arrastra el cursor: cambiar de filtro vuelve a la primera página", () => {
    const html = render({ axes: { availability: "ESPERANDO" } });

    expect(html).not.toContain("cursor=");
  });
});
