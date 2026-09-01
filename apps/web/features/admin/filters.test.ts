import { describe, expect, it } from "vitest";

import {
  adminPageHref,
  parseUserFilters,
  serializeUserFilters,
  type UserFilters,
} from "./filters";

// --------------------------------------------------------------------------
// El contrato de filtros vive en UN solo lugar.
//
// La página los lee de la URL, el repositorio los aplica y los enlaces los
// vuelven a escribir. Cuando cada una de esas tres capas interpreta los
// parámetros a su manera, alcanza con que una discrepe para que la pantalla
// muestre algo distinto de lo que el enlace prometía. Acá se prueba la única
// definición que las tres comparten.
// --------------------------------------------------------------------------

describe("parseUserFilters · lo que se acepta", () => {
  it("toma la búsqueda tal como se escribió", () => {
    expect(parseUserFilters({ q: "ana" }).q).toBe("ana");
  });

  it("normaliza los espacios: bordes y repetidos adentro", () => {
    expect(parseUserFilters({ q: "  ana   maria  " }).q).toBe("ana maria");
  });

  it("una búsqueda vacía equivale a no filtrar", () => {
    expect(parseUserFilters({ q: "   " }).q).toBeUndefined();
    expect(parseUserFilters({ q: "" }).q).toBeUndefined();
  });

  it("acepta un rol real", () => {
    expect(parseUserFilters({ role: "BODEGA" }).role).toBe("BODEGA");
  });

  it("acepta los dos estados del dominio cerrado", () => {
    expect(parseUserFilters({ status: "activos" }).status).toBe("activos");
    expect(parseUserFilters({ status: "inactivos" }).status).toBe("inactivos");
  });

  it("reconoce la vista de archivados", () => {
    expect(parseUserFilters({ archived: "true" }).archived).toBe(true);
  });

  it("por defecto la vista es la operativa", () => {
    expect(parseUserFilters({}).archived).toBe(false);
  });
});

describe("parseUserFilters · lo que se descarta", () => {
  // Un parámetro inventado no puede romper la pantalla: se cae al valor por
  // defecto, que es la vista que cualquiera espera ver.
  it("descarta un rol que no existe", () => {
    expect(parseUserFilters({ role: "DUEÑO" }).role).toBeUndefined();
  });

  it("descarta un rol con otra capitalización", () => {
    expect(parseUserFilters({ role: "bodega" }).role).toBeUndefined();
  });

  it("descarta un estado fuera del dominio", () => {
    expect(parseUserFilters({ status: "todos" }).status).toBeUndefined();
  });

  it("cualquier cosa que no sea 'true' deja la vista operativa", () => {
    expect(parseUserFilters({ archived: "1" }).archived).toBe(false);
    expect(parseUserFilters({ archived: "sí" }).archived).toBe(false);
  });

  // Un parámetro repetido llega como arreglo. No se adivina cuál vale.
  it("descarta un parámetro repetido", () => {
    expect(parseUserFilters({ role: ["ADMIN", "BODEGA"] }).role).toBeUndefined();
    expect(parseUserFilters({ q: ["ana", "juan"] }).q).toBeUndefined();
  });

  it("un parámetro inválido no arrastra a los válidos", () => {
    const filtros = parseUserFilters({ q: "ana", role: "INVENTADO", status: "activos" });

    expect(filtros.q).toBe("ana");
    expect(filtros.status).toBe("activos");
    expect(filtros.role).toBeUndefined();
  });
});

describe("serializeUserFilters", () => {
  it("omite lo que no está filtrado", () => {
    expect(serializeUserFilters({ archived: false })).toBe("");
  });

  it("escribe solo lo que tiene valor, en orden estable", () => {
    const filtros: UserFilters = {
      q: "ana maria",
      role: "ADMIN",
      status: "activos",
      archived: true,
      cursor: "c1",
    };

    expect(serializeUserFilters(filtros)).toBe(
      "q=ana+maria&role=ADMIN&status=activos&archived=true&cursor=c1",
    );
  });

  it("lo que sale de serializar vuelve a entrar igual", () => {
    const filtros: UserFilters = { q: "ana maria", role: "BODEGA", status: "inactivos", archived: true };
    const params = Object.fromEntries(new URLSearchParams(serializeUserFilters(filtros)));

    expect(parseUserFilters(params)).toEqual(filtros);
  });
});

describe("adminPageHref · los enlaces conservan los filtros", () => {
  const VIGENTES: UserFilters = {
    q: "ana",
    role: "ADMIN",
    status: "activos",
    archived: true,
    cursor: "viejo",
  };

  // El defecto que este slice corrige: el enlace de paginación armaba
  // `/admin?cursor=…` y tiraba todo lo demás. Paginar en la vista de archivados
  // devolvía a la de activos, con la búsqueda perdida.
  it("paginar conserva q, role, status y archived, y solo cambia el cursor", () => {
    const href = adminPageHref(VIGENTES, { cursor: "nuevo" });

    expect(href).toContain("q=ana");
    expect(href).toContain("role=ADMIN");
    expect(href).toContain("status=activos");
    expect(href).toContain("archived=true");
    expect(href).toContain("cursor=nuevo");
    expect(href).not.toContain("cursor=viejo");
  });

  // Cambiar un filtro cambia el conjunto de resultados: un cursor de la lista
  // anterior apunta a una posición que ya no significa nada.
  it("cambiar un filtro descarta el cursor anterior", () => {
    expect(adminPageHref(VIGENTES, { role: "BODEGA" })).not.toContain("cursor");
  });

  it("cambiar de vista descarta el cursor anterior", () => {
    expect(adminPageHref(VIGENTES, { archived: false })).not.toContain("cursor");
  });

  it("limpiar la búsqueda descarta el cursor anterior", () => {
    const href = adminPageHref(VIGENTES, { q: undefined });

    expect(href).not.toContain("cursor");
    expect(href).not.toContain("q=");
  });

  it("sin filtros ni cursor, el enlace es la vista limpia", () => {
    expect(adminPageHref({ archived: false }, {})).toBe("/admin");
  });
});
