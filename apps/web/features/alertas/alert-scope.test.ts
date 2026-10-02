import { describe, expect, it } from "vitest";

import { USER_ROLES } from "@/lib/auth/permissions";

import { alertScopeFor } from "./alert-scope";

// --------------------------------------------------------------------------
// El alcance del aviso operativo, fijado por rol.
//
// La tabla es la que regía ANTES de abrir la lectura global al vendedor
// (2026-09-30). Leer la cola entera ya no distingue a nadie —la tienen los
// cinco roles—, así que el aviso no puede derivarse de esa lectura: si lo
// hiciera, el vendedor pasaría a recibir los reclamos de toda la droguería sin
// que nadie lo hubiera decidido.
// --------------------------------------------------------------------------
describe("alertScopeFor · alcance por rol, idéntico al anterior", () => {
  it("cada rol conserva su alcance", () => {
    const alcance = USER_ROLES.map((role) => [role, alertScopeFor(role, "u-1")] as const);

    expect(alcance).toEqual([
      ["SUPERADMIN", { kind: "global" }],
      ["ADMIN", { kind: "global" }],
      ["SUPERVISOR", { kind: "global" }],
      ["OPERADOR", { kind: "owner", ownerId: "u-1" }],
      // Bodega recibía el aviso global en esta base (leía la cola entera y la
      // regla de lectura iba primero). Se conserva tal cual.
      ["BODEGA", { kind: "global" }],
    ]);
  });
});
