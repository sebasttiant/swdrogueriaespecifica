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
  }> = {},
): string {
  return renderToStaticMarkup(
    createElement(PendingReviewFilters, {
      axes: props.axes ?? {},
      scope: props.scope ?? "active",
      view: props.view ?? "lista",
    }),
  );
}

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
