import { describe, expect, it } from "vitest";

import {
  PENDING_IDENTITY_DEFERRAL_LABELS,
  PENDING_IDENTITY_DEFERRAL_REASONS,
} from "./identity-deferral";

// --------------------------------------------------------------------------
// La lista de motivos es CERRADA y se cuenta. Que un motivo tenga etiqueta no
// es cosmética: es lo que decide si la cola de revisión puede distinguir
// "Orion se cae seguido" de "estamos dando de alta productos nuevos", que
// piden acciones opuestas.
// --------------------------------------------------------------------------

describe("motivos de aplazamiento de identidad", () => {
  // El caso que faltaba: los cuatro motivos originales describen un FRACASO al
  // conseguir el código. Ninguno decía que el código todavía no existe, y ese
  // caso terminaba mezclado en "Otro motivo", donde no se puede contar.
  it("incluye el producto nuevo sin SKU, con la redacción que aprobó gerencia", () => {
    expect(PENDING_IDENTITY_DEFERRAL_REASONS).toContain("NEW_PRODUCT");
    expect(PENDING_IDENTITY_DEFERRAL_LABELS.NEW_PRODUCT).toBe(
      "Producto nuevo, aún sin SKU",
    );
  });

  // Va primero porque es el más común al dar de alta productos. Ponerlo último
  // obligaría a leer tres motivos que no aplican antes de encontrar el que sí.
  it("lo ofrece PRIMERO en el selector", () => {
    expect(PENDING_IDENTITY_DEFERRAL_REASONS[0]).toBe("NEW_PRODUCT");
  });

  it("conserva los cuatro motivos anteriores", () => {
    for (const motivo of [
      "ORION_UNAVAILABLE",
      "CODE_NOT_FOUND",
      "CODE_ALREADY_ASSIGNED",
      "OTHER",
    ] as const) {
      expect(PENDING_IDENTITY_DEFERRAL_REASONS).toContain(motivo);
    }
  });

  it("cada motivo tiene una etiqueta propia y no vacía", () => {
    const etiquetas = PENDING_IDENTITY_DEFERRAL_REASONS.map(
      (motivo) => PENDING_IDENTITY_DEFERRAL_LABELS[motivo],
    );

    for (const etiqueta of etiquetas) {
      expect(etiqueta.trim().length).toBeGreaterThan(0);
    }
    // Dos motivos con la misma etiqueta serían indistinguibles en pantalla.
    expect(new Set(etiquetas).size).toBe(etiquetas.length);
  });

  it("no hay motivos repetidos", () => {
    expect(new Set(PENDING_IDENTITY_DEFERRAL_REASONS).size).toBe(
      PENDING_IDENTITY_DEFERRAL_REASONS.length,
    );
  });
});
