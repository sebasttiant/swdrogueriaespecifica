import { describe, expect, it } from "vitest";

import {
  MISSING_SCOPES,
  PENDING_SUPPLY_ROUTE,
  SHELF_BOARD_ROUTE,
  MISSING_SCOPE_LABELS,
  missingPageHref,
  missingScopeHref,
  repositoryScopeFor,
  resolveMissingBulkMode,
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
  it("deja la ruta limpia para el scope por defecto", () => {
    expect(missingScopeHref("actionable")).toBe("/revision-faltantes");
  });

  it("pide un scope explícito", () => {
    expect(missingScopeHref("ordered")).toBe("/revision-faltantes?scope=ordered");
  });

  // Cambiar de scope NO arrastra el cursor: apuntaría a una fila que el nuevo
  // scope no contiene y la paginación quedaría en un estado imposible.
  it("nunca arrastra el cursor del scope anterior", () => {
    expect(missingScopeHref("discarded")).not.toContain("cursor");
  });
});

describe("missingPageHref", () => {
  // Pasar de página NO puede devolverte a otro scope: con 847 faltantes,
  // perder el lugar es perder el trabajo hecho.
  it("preserva el scope al pasar de página", () => {
    expect(missingPageHref("ordered", "cur-1")).toBe(
      "/revision-faltantes?scope=ordered&cursor=cur-1",
    );
  });

  it("escapa el cursor para que no rompa la URL", () => {
    expect(missingPageHref("actionable", "a b&c=d")).toContain(
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
    expect(missingScopeHref("ordered", SHELF_BOARD_ROUTE)).toBe(
      "/revision-faltantes?scope=ordered",
    );
  });

  it("el abastecimiento de cliente arma los suyos sobre Revisión de pendientes", () => {
    const href = missingScopeHref("ordered", PENDING_SUPPLY_ROUTE);

    expect(href.startsWith("/revision-pendientes?")).toBe(true);
  });

  // EL TEST QUE IMPORTA. Los nombres de parámetro de un tablero no pueden ser
  // los del otro, o los dos se pisan en la misma URL de Revisión de pendientes,
  // que ya usa `scope` y `cursor` para su lista de pendientes.
  it("no comparte NINGÚN nombre de parámetro entre los dos tableros", () => {
    const shelf = [SHELF_BOARD_ROUTE.scopeParam, SHELF_BOARD_ROUTE.cursorParam];
    const supply = [PENDING_SUPPLY_ROUTE.scopeParam, PENDING_SUPPLY_ROUTE.cursorParam];

    expect(supply.filter((param) => shelf.includes(param))).toEqual([]);
  });

  // Los nombres que Revisión de pendientes ya tiene ocupados con su propia
  // lista. Si el tablero de abastecimiento usara uno, pasar de página en él
  // movería también la lista de pendientes de la otra mitad.
  it("no usa los parámetros que Revisión de pendientes ya tiene ocupados", () => {
    const taken = ["scope", "view", "cursor", "purchase", "availability", "customer"];

    expect(taken).not.toContain(PENDING_SUPPLY_ROUTE.scopeParam);
    expect(taken).not.toContain(PENDING_SUPPLY_ROUTE.cursorParam);
  });

  // Sin esto, tocar "Ya pedidos" dentro del abastecimiento devuelve a
  // seguimiento: el enlace pierde la mitad en la que estás parado.
  it("arrastra la pestaña activa en TODOS los enlaces del abastecimiento", () => {
    const scopeHref = missingScopeHref("discarded", PENDING_SUPPLY_ROUTE);
    const pageHref = missingPageHref("ordered", "cur-1", PENDING_SUPPLY_ROUTE);

    expect(scopeHref).toContain("tab=abastecimiento");
    expect(pageHref).toContain("tab=abastecimiento");
  });

  it("pagina el abastecimiento con su propio cursor", () => {
    const href = missingPageHref("actionable", "cur-9", PENDING_SUPPLY_ROUTE);

    expect(href).toContain("scursor=cur-9");
    expect(href).not.toContain("cursor=cur-9&");
    expect(new URL(href, "https://x").searchParams.get("cursor")).toBeNull();
  });

  // El nombre del parámetro de selección masiva tampoco puede pisar los otros,
  // por la misma razón que ya obligó a `sscope`/`scursor`.
  it("el parámetro de selección masiva de cada tablero tiene su propio nombre", () => {
    expect(SHELF_BOARD_ROUTE.bulkParam).toBe("bulk");
    expect(PENDING_SUPPLY_ROUTE.bulkParam).toBe("sbulk");
    expect(PENDING_SUPPLY_ROUTE.bulkParam).not.toBe(SHELF_BOARD_ROUTE.bulkParam);

    const shelf = [
      SHELF_BOARD_ROUTE.scopeParam,
      SHELF_BOARD_ROUTE.cursorParam,
      SHELF_BOARD_ROUTE.bulkParam,
    ];
    const supply = [
      PENDING_SUPPLY_ROUTE.scopeParam,
      PENDING_SUPPLY_ROUTE.cursorParam,
      PENDING_SUPPLY_ROUTE.bulkParam,
    ];
    expect(supply.filter((param) => shelf.includes(param))).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Selección masiva: modo alternativo de la lista real, activado por URL.
// `missingHref` tiene que arrastrarlo igual que arrastra `persistentParams`:
// sin esto, tocar otra pestaña o cambiar de layout devolvería al modo normal
// en silencio, con la selección ya hecha perdida.
// --------------------------------------------------------------------------
describe("selección masiva en la URL", () => {
  it("no escribe el parámetro cuando el modo no se pide", () => {
    expect(missingScopeHref("actionable")).toBe("/revision-faltantes");
    expect(missingScopeHref("actionable", SHELF_BOARD_ROUTE, false)).toBe(
      "/revision-faltantes",
    );
  });

  it("escribe bulk=1 sobre la estantería cuando el modo está activo", () => {
    const href = missingScopeHref("actionable", SHELF_BOARD_ROUTE, true);

    expect(new URL(href, "https://x").searchParams.get("bulk")).toBe("1");
  });

  it("escribe sbulk=1 sobre el abastecimiento cuando el modo está activo", () => {
    const href = missingScopeHref("ordered", PENDING_SUPPLY_ROUTE, true);

    expect(new URL(href, "https://x").searchParams.get("sbulk")).toBe("1");
    // No pisa el nombre de la estantería.
    expect(new URL(href, "https://x").searchParams.get("bulk")).toBeNull();
  });

  it("conserva el modo masivo al cambiar de scope (missingScopeHref)", () => {
    expect(missingScopeHref("ordered", SHELF_BOARD_ROUTE, true)).toBe(
      "/revision-faltantes?scope=ordered&bulk=1",
    );
  });

  it("conserva el modo masivo al pasar de página (missingPageHref)", () => {
    const href = missingPageHref("ordered", "cur-1", SHELF_BOARD_ROUTE, true);

    expect(new URL(href, "https://x").searchParams.get("bulk")).toBe("1");
    expect(new URL(href, "https://x").searchParams.get("cursor")).toBe("cur-1");
  });

  it("conserva el modo masivo al pasar de página en el abastecimiento", () => {
    const href = missingPageHref("actionable", "cur-9", PENDING_SUPPLY_ROUTE, true);

    expect(new URL(href, "https://x").searchParams.get("sbulk")).toBe("1");
    expect(new URL(href, "https://x").searchParams.get("tab")).toBe("abastecimiento");
  });
});

// El parámetro que activa la selección masiva. Es input de usuario: cualquier
// basura tiene que caer en el modo normal, nunca romper la pantalla. (Movido
// desde `missing-view.ts`, junto con el toggle de layout que sí se retiró.)
describe("resolveMissingBulkMode", () => {
  it("activa el modo solo con el valor exacto '1'", () => {
    expect(resolveMissingBulkMode("1")).toBe(true);
  });

  it("cae en modo normal ante ausencia o basura", () => {
    expect(resolveMissingBulkMode(undefined)).toBe(false);
    expect(resolveMissingBulkMode(null)).toBe(false);
    expect(resolveMissingBulkMode("")).toBe(false);
    expect(resolveMissingBulkMode("true")).toBe(false);
    expect(resolveMissingBulkMode("0")).toBe(false);
    expect(resolveMissingBulkMode(" 1")).toBe(false);
  });
});
