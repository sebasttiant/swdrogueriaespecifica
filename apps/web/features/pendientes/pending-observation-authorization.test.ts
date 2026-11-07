import { describe, expect, it } from "vitest";

import { USER_ROLES, can, rolesWithCapability } from "@/lib/auth/permissions";

// --------------------------------------------------------------------------
// Quién escribe la nota sobre un pendiente ajeno.
//
// Nació como la voz de gerencia dirigida al vendedor que cargó el pendiente, y
// desde la reunión del 2026-11-06 la comparte bodega: doña Marta y David pidieron
// poder dejar escrito qué pasó con lo que llegaba —"pedí jarabe de 90 ml y llegó
// de 120"—, que hasta entonces se perdía en una llamada.
//
// Sigue siendo un eje PROPIO y no un pedazo de `canManageAllPendings`:
// supervisión opera la cola entera —entrega, factura, cancela— y aun así no
// escribe la nota. Si algún día alguien colapsa las dos capacidades para
// simplificar, estas pruebas caen antes de que llegue a producción.
// --------------------------------------------------------------------------

describe("canWriteManagementObservation", () => {
  it("la tienen gerencia y bodega, nadie más", () => {
    expect([...rolesWithCapability("canWriteManagementObservation")]).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "BODEGA",
    ]);
  });

  it("supervisión opera la cola completa y aun así no escribe la observación", () => {
    expect(can("SUPERVISOR", "canManageAllPendings")).toBe(true);
    expect(can("SUPERVISOR", "canWriteManagementObservation")).toBe(false);
  });

  it("el vendedor no la escribe: anota el pedido, no informa sobre lo ajeno", () => {
    expect(can("OPERADOR", "canWriteManagementObservation")).toBe(false);
  });

  it("bodega la escribe sin recibir con eso autoridad de compras", () => {
    expect(can("BODEGA", "canWriteManagementObservation")).toBe(true);
    expect(can("BODEGA", "canOrderMissingItems")).toBe(false);
  });

  it("no es un alias de otra capacidad: ningún rol la deriva de canReviewPendings", () => {
    const conRevision = USER_ROLES.filter((role) => can(role, "canReviewPendings"));
    const conObservacion = USER_ROLES.filter((role) =>
      can(role, "canWriteManagementObservation"),
    );
    expect(conRevision.length).toBeGreaterThan(conObservacion.length);
  });
});
