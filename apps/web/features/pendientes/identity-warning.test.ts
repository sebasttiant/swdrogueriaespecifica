import { describe, expect, it } from "vitest";

import {
  IDENTITY_WARNING_LABEL,
  identityWarning,
  type PendingIdentityView,
} from "./identity-warning";

// --------------------------------------------------------------------------
// S2b · 1e-E — el aviso de identidad pendiente.
//
// La regla es una sola y vive acá porque la comparten las dos listas. Cuando
// una regla así nace adentro de una lista, la otra muestra otra cosa: eso ya
// pasó con `fulfillmentNotice`, y la vista de revisión estuvo mostrando un
// pendiente ya cargado igual que uno que seguía esperando.
// --------------------------------------------------------------------------

function view(overrides: Partial<PendingIdentityView> = {}): PendingIdentityView {
  return {
    identitySkippedReason: null,
    product: { orionCode: null },
    ...overrides,
  };
}

describe("identityWarning", () => {
  it("avisa cuando se aplazó la identidad y el producto sigue sin código", () => {
    const item = view({
      identitySkippedReason: "ORION_UNAVAILABLE",
      product: { orionCode: null },
    });

    expect(identityWarning(item)).toBe(IDENTITY_WARNING_LABEL);
  });

  // El corazón de D9: la alerta se apaga sola por estado DERIVADO. Nadie corre
  // un job, nadie limpia una columna, y por eso no hay forma de que quede una
  // alerta vieja encendida sobre un producto que ya se identificó.
  it("deja de avisar en cuanto el producto recibe su código", () => {
    const item = view({
      identitySkippedReason: "ORION_UNAVAILABLE",
      product: { orionCode: "ORN-500" },
    });

    expect(identityWarning(item)).toBeNull();
  });

  // Un producto sin código NO es un aplazamiento. Los ~151 productos legados
  // están así y nadie los aplazó: tratarlos como aplazados inventaría una
  // historia que no ocurrió y llenaría la lista de avisos falsos.
  it("no avisa por un producto sin código que nadie aplazó", () => {
    const item = view({
      identitySkippedReason: null,
      product: { orionCode: null },
    });

    expect(identityWarning(item)).toBeNull();
  });

  it("no avisa por un pendiente anterior a S2b, que no tiene motivo", () => {
    expect(identityWarning(view())).toBeNull();
  });

  it("no avisa cuando el producto ya está identificado y nunca se aplazó", () => {
    const item = view({ product: { orionCode: "ORN-500" } });

    expect(identityWarning(item)).toBeNull();
  });

  // Sanar apaga el AVISO, no borra el motivo. El aplazamiento es historia
  // operativa permanente (D9): la fila sigue teniendo su motivo intacto
  // después de que el aviso se apagó, y es lo que hace medible la fricción.
  it("el motivo sigue estando después de sanar: solo se apagó el aviso", () => {
    const deferred = view({
      identitySkippedReason: "CODE_NOT_FOUND",
      product: { orionCode: null },
    });
    expect(identityWarning(deferred)).toBe(IDENTITY_WARNING_LABEL);

    const healed: PendingIdentityView = {
      ...deferred,
      product: { orionCode: "ORN-900" },
    };

    expect(identityWarning(healed)).toBeNull();
    // La función NO escribe: el motivo del original sigue donde estaba.
    expect(healed.identitySkippedReason).toBe("CODE_NOT_FOUND");
    expect(deferred.identitySkippedReason).toBe("CODE_NOT_FOUND");
  });

  // Los cuatro motivos de la lista cerrada avisan igual: el aviso depende de
  // que HAYA motivo, no de cuál sea.
  it.each([
    "ORION_UNAVAILABLE",
    "CODE_NOT_FOUND",
    "CODE_ALREADY_ASSIGNED",
    "OTHER",
  ] as const)("avisa con el motivo %s", (reason) => {
    const item = view({
      identitySkippedReason: reason,
      product: { orionCode: null },
    });

    expect(identityWarning(item)).toBe(IDENTITY_WARNING_LABEL);
  });
});
