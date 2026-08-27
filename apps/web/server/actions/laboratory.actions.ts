// --------------------------------------------------------------------------
// Server actions de laboratorio — búsqueda y creación.
//
// searchLaboratoriesAction: búsqueda normalizada, 8 resultados, prefijos
// primero. Retorna opciones para autocomplete.
//
// createLaboratoryAction: creación idempotente con command key/fingerprint.
// Requiere canManageLaboratories (ADMIN o superior).
// --------------------------------------------------------------------------

"use server";

import { auth } from "@/lib/auth/auth";
import { normalizeLaboratoryName } from "@/server/domain/laboratory/identity";
import {
  findOrCreateLaboratory,
  searchLaboratories,
} from "@/server/repositories/laboratory.repository";

// --------------------------------------------------------------------------
// Búsqueda — para autocomplete en formularios.
// --------------------------------------------------------------------------

export type SearchLaboratoriesResult = {
  ok: true;
  laboratories: {
    id: string;
    name: string;
    searchKey: string | null;
    needsReview: boolean;
  }[];
} | {
  ok: false;
  error: string;
};

/**
 * Busca laboratorios por nombre. Retorna máximo 8 resultados con prefijos
 * primero. Para autocomplete en formularios de pendientes, faltantes y
 * productos.
 */
export async function searchLaboratoriesAction(
  query: string,
): Promise<SearchLaboratoriesResult> {
  try {
    const normalized = normalizeLaboratoryName(query);
    if (normalized.length === 0) {
      return { ok: true, laboratories: [] };
    }

    const laboratories = await searchLaboratories(query);
    return { ok: true, laboratories };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Error desconocido",
    };
  }
}

// --------------------------------------------------------------------------
// Creación — con idempotencia y permisos.
// --------------------------------------------------------------------------

export type CreateLaboratoryResult = {
  ok: true;
  laboratory: { id: string; name: string; needsReview: boolean };
  status: "created" | "exists";
} | {
  ok: false;
  error: string;
  code?: string;
};

/**
 * Crea un laboratorio de forma idempotente. Si ya existe uno con el mismo
 * nombre normalizado, retorna el existente.
 *
 * Requiere permiso canManageLaboratories (ADMIN o superior).
 */
export async function createLaboratoryAction(
  name: string,
): Promise<CreateLaboratoryResult> {
  try {
    const session = await auth();
    const user = session?.user;

    if (!user) {
      return { ok: false, error: "No autenticado" };
    }

    // Solo ADMIN, SUPERVISOR y SUPERADMIN pueden crear laboratorios
    if (!["ADMIN", "SUPERVISOR", "SUPERADMIN"].includes(user.role)) {
      return {
        ok: false,
        error: "No tienes permiso para crear laboratorios",
        code: "FORBIDDEN_ACTOR",
      };
    }

    const result = await findOrCreateLaboratory({ name });

    return {
      ok: true,
      laboratory: {
        id: result.laboratory.id,
        name: result.laboratory.name,
        needsReview: result.laboratory.needsReview,
      },
      status: result.status === "created" ? "created" : "exists",
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined;
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Error desconocido",
      code,
    };
  }
}
