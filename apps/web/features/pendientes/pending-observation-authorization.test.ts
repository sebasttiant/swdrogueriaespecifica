import { describe, expect, it } from "vitest";

import { USER_ROLES, can, rolesWithCapability } from "@/lib/auth/permissions";

// --------------------------------------------------------------------------
// Quién habla en nombre de gerencia.
//
// La observación es la voz de gerencia dirigida al vendedor que cargó el
// pendiente. Es un eje PROPIO y no un pedazo de `canManageAllPendings`:
// supervisión opera la cola entera —entrega, factura, cancela— y aun así no
// habla por gerencia. Si algún día alguien colapsa las dos capacidades para
// simplificar, estas pruebas caen antes de que llegue a producción.
// --------------------------------------------------------------------------

describe("canWriteManagementObservation", () => {
  it("lo tienen exactamente ADMIN y SUPERADMIN", () => {
    expect([...rolesWithCapability("canWriteManagementObservation")]).toEqual([
      "SUPERADMIN",
      "ADMIN",
    ]);
  });

  it("supervisión opera la cola completa y aun así no escribe la observación", () => {
    expect(can("SUPERVISOR", "canManageAllPendings")).toBe(true);
    expect(can("SUPERVISOR", "canWriteManagementObservation")).toBe(false);
  });

  it("ni el vendedor ni bodega la escriben", () => {
    expect(can("OPERADOR", "canWriteManagementObservation")).toBe(false);
    expect(can("BODEGA", "canWriteManagementObservation")).toBe(false);
  });

  it("no es un alias de otra capacidad: ningún rol la deriva de canReviewPendings", () => {
    const conRevision = USER_ROLES.filter((role) => can(role, "canReviewPendings"));
    const conObservacion = USER_ROLES.filter((role) =>
      can(role, "canWriteManagementObservation"),
    );
    expect(conRevision.length).toBeGreaterThan(conObservacion.length);
  });
});
