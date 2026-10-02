import { can } from "@/lib/auth/permissions";
import type { SessionRole } from "@/lib/auth/session";
import type { AlertScope } from "@/server/services/operational-alerts.service";

// El aviso le habla al responsable, no a quien pase por ahí.
//
// Gerencia y supervisión ven el estado de toda la droguería. El vendedor ve
// SOLO las entregas que él prometió: un lote por vencer no lo resuelve él. La
// bodega recibe UN solo aviso, el suyo: un producto que la droguería lleva se
// quedó sin con qué cubrir lo prometido, y antes de comprarlo hay que mirar el
// depósito.
//
// Leer la cola entera (`seesAllPendings`) YA NO decide el alcance: desde el
// 2026-09-30 la tienen los cinco roles, y derivar el aviso de esa lectura le
// habría mandado al vendedor los reclamos de toda la droguería. El alcance
// global lo da operar la cola (`canManageAllPendings`) o recibir la mercadería
// leyendo la cola entera (`canReceiveMissingItems` + `canReadAllPendings`), que
// es exactamente como resolvía cada rol antes del cambio: bodega recibía el
// aviso global porque la regla de lectura iba primero. Esa tabla está fijada
// por rol en `alert-scope.test.ts`.
export function alertScopeFor(role: SessionRole, userId: string): AlertScope {
  if (can(role, "canManageAllPendings")) return { kind: "global" };
  if (can(role, "canReceiveMissingItems") && can(role, "canReadAllPendings")) {
    return { kind: "global" };
  }
  // Recepción sin lectura global ni autoridad de compras: el aviso propio de
  // bodega. Ningún rol de la matriz actual cae acá (ver la nota de arriba).
  if (can(role, "canReceiveMissingItems") && !can(role, "canOrderMissingItems")) {
    return { kind: "warehouse" };
  }
  if (can(role, "canViewPendientes")) return { kind: "owner", ownerId: userId };
  return { kind: "none" };
}
