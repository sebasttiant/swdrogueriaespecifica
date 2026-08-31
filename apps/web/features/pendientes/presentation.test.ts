import { describe, expect, it } from "vitest";

import {
  MANUAL_UNIT_FALLBACK,
  NO_PRESENTATION_LABEL,
  PRESENTATION_LABEL,
  hasPresentation,
  presentationLabel,
} from "./presentation";

// --------------------------------------------------------------------------
// La presentación tiene UNA regla para los dos orígenes.
//
// Producto del catálogo y producto manual leen los dos `product.unit`: lo que
// el vendedor escribe en `manualUnit` termina guardado ahí al crear el
// producto. Estas pruebas fijan eso, porque la tentación de ramificar por
// origen aparece cada vez que alguien toca una de las cuatro pantallas.
// --------------------------------------------------------------------------

describe("presentación · producto del catálogo", () => {
  it("muestra la presentación tal como está guardada", () => {
    expect(presentationLabel("Frasco")).toBe("Frasco");
  });

  it("respeta las presentaciones de droguería sin normalizarlas", () => {
    for (const unidad of ["Frasco", "Sobre", "Caja", "Blíster", "Ampolla"]) {
      expect(presentationLabel(unidad)).toBe(unidad);
    }
  });

  it("recorta los espacios de los lados, que son ruido de carga", () => {
    expect(presentationLabel("  Caja  ")).toBe("Caja");
  });
});

describe("presentación · producto sin presentación cargada", () => {
  // Se dice explícitamente en vez de dejar el hueco: un espacio en blanco no
  // distingue "el producto no la tiene" de "la pantalla no cargó el dato", y
  // quien decide una compra necesita esa diferencia.
  it("lo dice con palabras cuando está vacía", () => {
    expect(presentationLabel("")).toBe(NO_PRESENTATION_LABEL);
  });

  it("una cadena de solo espacios es lo mismo que vacía", () => {
    expect(presentationLabel("   ")).toBe(NO_PRESENTATION_LABEL);
  });

  // `unit` es `String` no nulo en el esquema, pero los productos legados y
  // cualquier proyección parcial pueden llegar sin el campo. No puede reventar
  // una lista entera por eso.
  it("null y undefined tampoco rompen la pantalla", () => {
    expect(presentationLabel(null)).toBe(NO_PRESENTATION_LABEL);
    expect(presentationLabel(undefined)).toBe(NO_PRESENTATION_LABEL);
  });

  it("nunca devuelve cadena vacía: siempre hay algo que leer", () => {
    for (const entrada of ["", "   ", null, undefined]) {
      expect(presentationLabel(entrada).length).toBeGreaterThan(0);
    }
  });
});

describe("presentación · producto manual", () => {
  // Lo que el vendedor escribió en `manualUnit` viaja en `product.unit`: para
  // esta regla es exactamente el mismo caso que un producto del catálogo.
  it("lee el mismo campo que el producto del catálogo", () => {
    expect(presentationLabel("Sobre")).toBe("Sobre");
  });

  // El caso que motivó revisar esto. Cuando el vendedor deja el campo vacío,
  // el formulario guarda "unidad" para poder escribir la fila. Ese texto NO lo
  // escribió nadie, y mostrarlo como presentación es presentar un relleno del
  // sistema como si fuera un dato: quien lee la pantalla no puede distinguirlo
  // de una presentación de verdad y decide una compra creyendo que alguien la
  // registró.
  it("el relleno del formulario NO se muestra como una presentación real", () => {
    expect(presentationLabel(MANUAL_UNIT_FALLBACK)).toBe(NO_PRESENTATION_LABEL);
    expect(presentationLabel("unidad")).toBe(NO_PRESENTATION_LABEL);
  });

  it("da igual cómo esté escrito: es el mismo relleno", () => {
    for (const variante of ["Unidad", "UNIDAD", "  unidad  "]) {
      expect(presentationLabel(variante)).toBe(NO_PRESENTATION_LABEL);
    }
  });

  // Una presentación de verdad no se toca, aunque contenga la palabra.
  it("una presentación real que menciona la palabra sí se muestra", () => {
    expect(presentationLabel("Caja x 10 unidades")).toBe("Caja x 10 unidades");
    expect(presentationLabel("unidad blíster")).toBe("unidad blíster");
  });

  it("hasPresentation también lo considera ausente", () => {
    expect(hasPresentation(MANUAL_UNIT_FALLBACK)).toBe(false);
    expect(hasPresentation("Frasco")).toBe(true);
  });
});

describe("presentación · hasPresentation", () => {
  it("distingue tener de no tener, sin comparar contra texto de pantalla", () => {
    expect(hasPresentation("Frasco")).toBe(true);
    expect(hasPresentation("")).toBe(false);
    expect(hasPresentation("   ")).toBe(false);
    expect(hasPresentation(null)).toBe(false);
  });

  // La etiqueta es texto de pantalla, no un valor: si alguien la usara como
  // centinela, un producto llamado "Sin presentación" rompería la regla.
  it("no confunde la etiqueta con un valor real", () => {
    expect(hasPresentation(NO_PRESENTATION_LABEL)).toBe(true);
  });
});

describe("presentación · el rótulo", () => {
  it("se llama igual en todas las pantallas", () => {
    expect(PRESENTATION_LABEL).toBe("Presentación");
  });
});
