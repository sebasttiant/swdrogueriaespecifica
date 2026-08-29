import { describe, expect, it } from "vitest";

import {
  MISSING_SCOPES,
  PENDING_SUPPLY_ROUTE,
  SHELF_BOARD_ROUTE,
  MISSING_SCOPE_LABELS,
  missingPageHref,
  missingScopeHref,
  repositoryScopeFor,
  resolveMissingScope,
} from "./missing-scope";

describe("resolveMissingScope", () => {
  // El default es la cola de trabajo: lo primero que ve el gerente al entrar es
  // lo que TIENE QUE HACER, no el archivo de lo ya resuelto.
  it("cae en 'actionable' sin parámetro", () => {
    expect(resolveMissingScope()).toBe("actionable");
    expect(resolveMissingScope(null)).toBe("actionable");
    expect(resolveMissingScope("")).toBe("actionable");
  });

  it("reconoce los scopes válidos", () => {
    expect(resolveMissingScope("ordered")).toBe("ordered");
    expect(resolveMissingScope("discarded")).toBe("discarded");
    expect(resolveMissingScope("actionable")).toBe("actionable");
  });

  // El parámetro viene de la URL: es input del usuario. Basura conocida cae en
  // la vista segura, nunca rompe la página ni filtra otra cosa.
  it("cae en 'actionable' ante un valor desconocido", () => {
    expect(resolveMissingScope("history")).toBe("actionable");
    expect(resolveMissingScope("../../etc/passwd")).toBe("actionable");
    expect(resolveMissingScope("ORDERED")).toBe("actionable");
  });
});

describe("MISSING_SCOPE_LABELS", () => {
  // Las palabras son las del gerente, no las del modelo de datos. "Por pedir"
  // le dice qué hacer; "actionable" no le dice nada a alguien de 60 años que
  // entra desde el celular.
  it("usa el lenguaje de la droguería", () => {
    expect(MISSING_SCOPE_LABELS.actionable).toBe("Por pedir");
    expect(MISSING_SCOPE_LABELS.ordered).toBe("Ya pedidos");
    expect(MISSING_SCOPE_LABELS.discarded).toBe("Descartados");
  });

  it("tiene una etiqueta por cada scope, sin huecos", () => {
    for (const scope of MISSING_SCOPES) {
      expect(MISSING_SCOPE_LABELS[scope]).toBeTruthy();
    }
  });
});

describe("missingScopeHref", () => {
  // La cola de trabajo es la URL limpia: es la que el gerente va a guardar en
  // favoritos y abrir 30 veces por día.
  // La vista por defecto es la COMPACTA, no la completa: así lo fija
  // `resolveMissingView`. La URL limpia es la de esa vista; la completa tiene
  // que pedirse explícitamente, o el enlace de "Completa" quedaría apuntando a
  // una URL que el resolvedor lee como compacta —y era exactamente el bug: el
  // botón no se podía activar.
  it("deja la ruta limpia para la vista por defecto", () => {
    expect(missingScopeHref("actionable", "compact")).toBe("/revision-faltantes");
  });

  it("pide la vista completa de forma explícita", () => {
    expect(missingScopeHref("actionable", "full")).toBe("/revision-faltantes?view=full");
  });

  it("conserva el layout elegido al cambiar de vista", () => {
    expect(missingScopeHref("ordered", "full")).toBe(
      "/revision-faltantes?scope=ordered&view=full",
    );
    expect(missingScopeHref("ordered", "compact")).toBe("/revision-faltantes?scope=ordered");
  });

  // Cambiar de vista NO arrastra el cursor: apuntaría a una fila que la nueva
  // vista no contiene y la paginación quedaría en un estado imposible.
  it("nunca arrastra el cursor de la vista anterior", () => {
    expect(missingScopeHref("discarded", "full")).not.toContain("cursor");
  });
});

describe("missingPageHref", () => {
  // Pasar de página NO puede devolverte a otra vista: con 847 faltantes,
  // perder el lugar es perder el trabajo hecho.
  it("preserva vista y layout al pasar de página", () => {
    expect(missingPageHref("ordered", "full", "cur-1")).toBe(
      "/revision-faltantes?scope=ordered&view=full&cursor=cur-1",
    );
    expect(missingPageHref("ordered", "compact", "cur-1")).toBe(
      "/revision-faltantes?scope=ordered&cursor=cur-1",
    );
  });

  it("escapa el cursor para que no rompa la URL", () => {
    expect(missingPageHref("actionable", "full", "a b&c=d")).toContain(
      "cursor=a+b%26c%3Dd",
    );
  });
});

describe("repositoryScopeFor", () => {
  it("mapea cada vista a su filtro del repositorio", () => {
    expect(repositoryScopeFor("actionable")).toBe("actionable");
    expect(repositoryScopeFor("ordered")).toBe("ordered");
    expect(repositoryScopeFor("discarded")).toBe("discarded");
  });
});

// --------------------------------------------------------------------------
// La misma cola se pinta en DOS pantallas. Estos tests existen porque la
// colisión de parámetros ya rompió esta pantalla una vez: al mudar el tablero,
// el buzón de reportes compartía `?scope=` con la cola y moverse en uno movía
// el otro. Se resolvió a mano con `rscope`; acá se resuelve por construcción.
// --------------------------------------------------------------------------
describe("rutas de tablero", () => {
  it("la estantería arma sus enlaces sobre Revisión de faltantes", () => {
    expect(missingScopeHref("ordered", "compact", SHELF_BOARD_ROUTE)).toBe(
      "/revision-faltantes?scope=ordered",
    );
  });

  it("el abastecimiento de cliente arma los suyos sobre Revisión de pendientes", () => {
    const href = missingScopeHref("ordered", "compact", PENDING_SUPPLY_ROUTE);

    expect(href.startsWith("/revision-pendientes?")).toBe(true);
  });

  // EL TEST QUE IMPORTA. Los nombres de parámetro de un tablero no pueden ser
  // los del otro, o los dos se pisan en la misma URL de Revisión de pendientes,
  // que ya usa `scope`, `view` y `cursor` para su lista de pendientes.
  it("no comparte NINGÚN nombre de parámetro entre los dos tableros", () => {
    const shelf = [
      SHELF_BOARD_ROUTE.scopeParam,
      SHELF_BOARD_ROUTE.viewParam,
      SHELF_BOARD_ROUTE.cursorParam,
    ];
    const supply = [
      PENDING_SUPPLY_ROUTE.scopeParam,
      PENDING_SUPPLY_ROUTE.viewParam,
      PENDING_SUPPLY_ROUTE.cursorParam,
    ];

    expect(supply.filter((param) => shelf.includes(param))).toEqual([]);
  });

  // Los tres nombres que Revisión de pendientes ya tiene ocupados con su propia
  // lista. Si el tablero de abastecimiento usara uno, pasar de página en él
  // movería también la lista de pendientes de la otra mitad.
  it("no usa los parámetros que Revisión de pendientes ya tiene ocupados", () => {
    const taken = ["scope", "view", "cursor", "purchase", "availability", "customer"];

    expect(taken).not.toContain(PENDING_SUPPLY_ROUTE.scopeParam);
    expect(taken).not.toContain(PENDING_SUPPLY_ROUTE.viewParam);
    expect(taken).not.toContain(PENDING_SUPPLY_ROUTE.cursorParam);
  });

  // Sin esto, tocar "Ya pedidos" dentro del abastecimiento devuelve a
  // seguimiento: el enlace pierde la mitad en la que estás parado.
  it("arrastra la pestaña activa en TODOS los enlaces del abastecimiento", () => {
    const scopeHref = missingScopeHref("discarded", "full", PENDING_SUPPLY_ROUTE);
    const pageHref = missingPageHref("ordered", "compact", "cur-1", PENDING_SUPPLY_ROUTE);

    expect(scopeHref).toContain("tab=abastecimiento");
    expect(pageHref).toContain("tab=abastecimiento");
  });

  it("pagina el abastecimiento con su propio cursor", () => {
    const href = missingPageHref("actionable", "compact", "cur-9", PENDING_SUPPLY_ROUTE);

    expect(href).toContain("scursor=cur-9");
    expect(href).not.toContain("cursor=cur-9&");
    expect(new URL(href, "https://x").searchParams.get("cursor")).toBeNull();
  });
});
