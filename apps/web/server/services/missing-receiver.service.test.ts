import { describe, expect, it } from "vitest";

import { RECEIVER_STATUSES, resolveReceiverScope } from "./missing-receiver.service";

// --------------------------------------------------------------------------
// El scope viene de la URL, así que es entrada de usuario.
//
// Esconder las pestañas no alcanza: quien escribe `?scope=pending` a mano tiene
// que caer en la cola PERMITIDA, no en un error que delate que existe otra ni
// —mucho peor— en la cola de compras.
// --------------------------------------------------------------------------
describe("resolveReceiverScope", () => {
  it("abre en 'Ya pedidos' por defecto", () => {
    expect(resolveReceiverScope(undefined)).toBe("PEDIDO");
    expect(resolveReceiverScope(null)).toBe("PEDIDO");
  });

  it("acepta 'En bodega'", () => {
    expect(resolveReceiverScope("arrived")).toBe("EN_BODEGA");
  });

  // Los scopes de gerencia escritos a mano.
  it.each(["pending", "discarded", "ordered", "cualquier-cosa", ""])(
    "cae en 'Ya pedidos' con %s",
    (param) => {
      expect(resolveReceiverScope(param)).toBe("PEDIDO");
    },
  );

  it("NUNCA devuelve un estado fuera de los dos permitidos", () => {
    for (const param of ["pending", "discarded", "FALTANTE", "CANCELADO", null]) {
      expect(RECEIVER_STATUSES).toContain(resolveReceiverScope(param));
    }
  });
});

describe("RECEIVER_STATUSES", () => {
  // FALTANTE queda afuera porque nadie lo compró: mostrarlo invitaría a recibir
  // mercadería que no se pidió. CANCELADO, porque ya no va a llegar.
  it("son exactamente PEDIDO y EN_BODEGA", () => {
    expect([...RECEIVER_STATUSES]).toEqual(["PEDIDO", "EN_BODEGA"]);
  });

  it("no incluye los estados de compras", () => {
    for (const fuera of ["FALTANTE", "CANCELADO", "RECIBIDO"]) {
      expect(RECEIVER_STATUSES).not.toContain(fuera);
    }
  });
});
