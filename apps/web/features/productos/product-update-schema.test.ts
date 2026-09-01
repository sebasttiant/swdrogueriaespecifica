import { describe, expect, it } from "vitest";

import { productUpdateSchema } from "./schema";

// --------------------------------------------------------------------------
// La regla de fondo de todo el módulo de inventario, fijada en el borde de
// entrada: PRODUCTOS ADMINISTRA IDENTIDAD, ENTRADAS Y SALIDAS ADMINISTRAN
// CANTIDADES.
//
// Si el stock se pudiera escribir a mano, cualquier cuadre posterior sería una
// ficción: nadie podría reconstruir de dónde salió ese número. Por eso lo que
// se prueba acá no es solo qué acepta el esquema, sino sobre todo qué DESCARTA.
// --------------------------------------------------------------------------

const BASE = {
  id: "prod-1",
  code: "MED-001",
  name: "Dolex Niños",
  unit: "Frasco",
  minStock: "5",
  reorderQty: "20",
  expectedVersion: "3",
};

describe("edición de producto · lo que se puede cambiar", () => {
  it("acepta los datos de catálogo", () => {
    const parsed = productUpdateSchema.parse({ ...BASE, active: "on" });

    expect(parsed).toMatchObject({
      id: "prod-1",
      code: "MED-001",
      name: "Dolex Niños",
      unit: "Frasco",
      minStock: 5,
      reorderQty: 20,
      active: true,
    });
  });

  it("recorta los espacios de los lados", () => {
    const parsed = productUpdateSchema.parse({
      ...BASE,
      name: "  Dolex Niños  ",
      code: "  MED-001  ",
    });

    expect(parsed.name).toBe("Dolex Niños");
    expect(parsed.code).toBe("MED-001");
  });

  it("exige nombre, código y presentación", () => {
    for (const campo of ["name", "code", "unit"] as const) {
      expect(productUpdateSchema.safeParse({ ...BASE, [campo]: "" }).success).toBe(false);
    }
  });

  it("no acepta mínimos negativos", () => {
    expect(productUpdateSchema.safeParse({ ...BASE, minStock: "-1" }).success).toBe(false);
    expect(productUpdateSchema.safeParse({ ...BASE, reorderQty: "-1" }).success).toBe(false);
  });
});

describe("edición de producto · la casilla de activo", () => {
  // Una casilla NO marcada no viaja en el FormData. Leer eso como "no me lo
  // mandaron, dejalo como estaba" haría imposible desactivar un producto; y
  // leer al revés lo desactivaría en silencio al guardar cualquier otro campo.
  it("marcada es activo", () => {
    expect(productUpdateSchema.parse({ ...BASE, active: "on" }).active).toBe(true);
  });

  it("ausente es DESACTIVADO, que es lo que significa una casilla sin marcar", () => {
    expect(productUpdateSchema.parse(BASE).active).toBe(false);
    expect(productUpdateSchema.parse({ ...BASE, active: undefined }).active).toBe(false);
  });
});

describe("edición de producto · el laboratorio se puede QUITAR", () => {
  it("un id lo vincula", () => {
    expect(productUpdateSchema.parse({ ...BASE, laboratoryId: "lab-1" }).laboratoryId).toBe(
      "lab-1",
    );
  });

  // Vacío tiene que significar "sin laboratorio", no "no lo mandaron":
  // desvincular es una edición legítima y si no se distingue, es imposible.
  it("vacío lo desvincula", () => {
    expect(productUpdateSchema.parse({ ...BASE, laboratoryId: "" }).laboratoryId).toBeNull();
    expect(productUpdateSchema.parse(BASE).laboratoryId).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Lo que el esquema TIENE que descartar. Esta es la prueba que importa.
// --------------------------------------------------------------------------
describe("edición de producto · lo que NO se puede tocar desde acá", () => {
  it("descarta cualquier intento de escribir cantidades", () => {
    const parsed = productUpdateSchema.parse({
      ...BASE,
      // Lo que mandaría alguien llamando la Server Action a mano.
      stock: "20",
      quantity: "20",
      onHand: "20",
      sellableStock: "20",
      batchQuantity: "20",
    });

    const claves = Object.keys(parsed);
    for (const prohibida of ["stock", "quantity", "onHand", "sellableStock", "batchQuantity"]) {
      expect(claves, `el esquema dejó pasar ${prohibida}`).not.toContain(prohibida);
    }
  });

  // El SKU tiene su propio circuito con control de concurrencia: vincularlo
  // cuando falta y corregirlo cuando ya existe son dos actos distintos. Colarlo
  // acá convertiría "moví una identidad que todo el inventario referencia" en
  // un efecto colateral de guardar el nombre.
  it("descarta el SKU y la versión de identidad", () => {
    const claves = Object.keys(
      productUpdateSchema.parse({
        ...BASE,
        orionCode: "ORN-999",
        internalSku: "SKU-1",
        identityVersion: "7",
      }),
    );

    expect(claves).not.toContain("orionCode");
    expect(claves).not.toContain("internalSku");
    expect(claves).not.toContain("identityVersion");
  });

  it("descarta banderas que solo puede escribir una migración", () => {
    const claves = Object.keys(
      productUpdateSchema.parse({ ...BASE, legacyBeta: "true", needsReview: "true" }),
    );

    expect(claves).not.toContain("legacyBeta");
    expect(claves).not.toContain("needsReview");
  });

  it("el resultado tiene EXACTAMENTE los campos de catálogo, ni uno más", () => {
    // Con TODOS los campos presentes, para que la lista sea la completa:
    // `laboratoryName` es opcional y sin él la comparación probaría de menos.
    const claves = Object.keys(
      productUpdateSchema.parse({ ...BASE, active: "on", laboratoryName: "Genfar" }),
    ).sort();

    expect(claves).toEqual(
      [
        "active",
        "code",
        "expectedVersion",
        "id",
        "laboratoryId",
        "laboratoryName",
        "minStock",
        "name",
        "reorderQty",
        "unit",
      ].sort(),
    );
  });
});

// --------------------------------------------------------------------------
// El nombre ESCRITO en el buscador de laboratorio.
//
// El buscador suelta la selección en cuanto alguien escribe algo distinto de
// lo elegido: manda el id vacío y el texto en `laboratoryName`. Si el esquema
// no lo acepta, ese texto se pierde y "escribí Genfar y guardé" termina
// quitando el laboratorio con la pantalla mostrando Genfar.
// --------------------------------------------------------------------------
describe("edición de producto · el laboratorio escrito a mano", () => {
  it("acepta el nombre tipeado aunque no haya id", () => {
    const parsed = productUpdateSchema.parse({ ...BASE, laboratoryName: "Genfar" });

    expect(parsed.laboratoryId).toBeNull();
    expect(parsed.laboratoryName).toBe("Genfar");
  });

  it("lo recorta", () => {
    expect(productUpdateSchema.parse({ ...BASE, laboratoryName: "  Genfar  " }).laboratoryName)
      .toBe("Genfar");
  });

  it("sin nombre escrito, no hay nada que resolver", () => {
    expect(productUpdateSchema.parse(BASE).laboratoryName).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// El testigo del compare-and-set.
//
// Este formulario manda TODOS los campos, así que dos personas editando cosas
// distintas del mismo producto se pisan: la última en guardar reescribe con
// los valores viejos de su propia pantalla lo que la otra acababa de corregir.
//
// Es un ENTERO y no una fecha, y esa es la corrección de fondo: `updatedAt`
// dice cuándo pasó algo, no en qué orden. `TIMESTAMP(3)` tiene resolución de
// milisegundo y PostgreSQL no promete que dos escrituras rápidas caigan en
// milisegundos distintos; con marcas iguales, un control que las compara deja
// pasar la escritura que debía rechazar.
// --------------------------------------------------------------------------
describe("edición de producto · la versión de catálogo", () => {
  it("llega como número, no como fecha", () => {
    const parsed = productUpdateSchema.parse(BASE);

    expect(parsed.expectedVersion).toBe(3);
    expect(typeof parsed.expectedVersion).toBe("number");
  });

  it("acepta el cero: un producto que nunca se editó", () => {
    expect(productUpdateSchema.parse({ ...BASE, expectedVersion: "0" }).expectedVersion)
      .toBe(0);
  });

  it("es obligatoria: sin ella no se puede detectar un pisotón", () => {
    const { expectedVersion: _quitada, ...sinVersion } = BASE;
    expect(productUpdateSchema.safeParse(sinVersion).success).toBe(false);
  });

  it("rechaza lo que no es un entero", () => {
    for (const basura of ["ayer", "", "3.5", "-1", "N", "2026-08-31T12:00:00.000Z"]) {
      expect(
        productUpdateSchema.safeParse({ ...BASE, expectedVersion: basura }).success,
        basura,
      ).toBe(false);
    }
  });
});
