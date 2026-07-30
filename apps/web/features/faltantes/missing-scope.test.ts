import { describe, expect, it } from "vitest";

import {
  MISSING_SCOPES,
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
  it("deja /faltantes limpio para la vista por defecto", () => {
    expect(missingScopeHref("actionable", "full")).toBe("/faltantes");
  });

  it("conserva el layout elegido al cambiar de vista", () => {
    expect(missingScopeHref("ordered", "compact")).toBe(
      "/faltantes?scope=ordered&view=compact",
    );
    expect(missingScopeHref("actionable", "compact")).toBe("/faltantes?view=compact");
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
    expect(missingPageHref("ordered", "compact", "cur-1")).toBe(
      "/faltantes?scope=ordered&view=compact&cursor=cur-1",
    );
    expect(missingPageHref("actionable", "full", "cur-1")).toBe(
      "/faltantes?cursor=cur-1",
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
