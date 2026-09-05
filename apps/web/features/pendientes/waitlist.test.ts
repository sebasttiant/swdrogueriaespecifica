import { describe, expect, it } from "vitest";

import { WAITLIST_STATUSES, acceptsWaitlistDecision } from "./waitlist";

describe("acceptsWaitlistDecision", () => {
  it("acepta todos los estados abiertos que todavía esperan algo", () => {
    for (const status of WAITLIST_STATUSES) {
      expect(acceptsWaitlistDecision(status)).toBe(true);
    }
  });

  // AGOTADO no se consigue: no hay nada que esperar. Su salida es que el
  // vendedor le avise al cliente y lo rechace. Metido en la lista de espera
  // pondría a alguien a esperar algo que ya sabemos que no va a llegar.
  it("deja AGOTADO afuera aunque el pendiente siga abierto", () => {
    expect(acceptsWaitlistDecision("AGOTADO")).toBe(false);
  });

  it("deja afuera los estados terminales", () => {
    for (const status of ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"]) {
      expect(acceptsWaitlistDecision(status)).toBe(false);
    }
  });

  it("no explota con lo que no es un estado", () => {
    for (const value of [null, undefined, 7, {}, ""]) {
      expect(acceptsWaitlistDecision(value)).toBe(false);
    }
  });
});
