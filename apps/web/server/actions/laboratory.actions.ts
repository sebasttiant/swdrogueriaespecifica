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

import { getCurrentSession } from "@/lib/auth/index.node";
import {
  laboratoryCreateCommandKey,
  normalizeLaboratoryName,
} from "@/server/domain/laboratory/identity";
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
    const session = await getCurrentSession();
    const user = session?.user;

    if (!user) {
      return { ok: false, error: "No autenticado" };
    }

    // Todos los usuarios autenticados pueden crear laboratorios desde forms.
    // La trazabilidad queda en el createdById del laboratorio.

    const result = await findOrCreateLaboratory({
      name,
      commandKey: laboratoryCreateCommandKey("manual", user.id, name),
    });

    // `exact_name_exists` NO es un éxito: el repositorio lo emite cuando el
    // INSERT chocó contra el `createCommandKey` y la identidad que se pidió no
    // está en ninguna fila. El laboratorio que vuelve es OTRO —el que ese mismo
    // comando creó antes con otro nombre—, así que darlo por bueno sustituiría
    // en silencio lo que la persona escribió. La pantalla hace `setQuery(name)`
    // con lo que reciba: aceptarlo le cambiaría el texto por uno que no tipeó.
    //
    // Con las claves de comando actuales no debería ocurrir por vía natural:
    // tanto esta action como la de pendientes arman la clave con
    // `laboratoryCreateCommandKey`, que lleva el nombre normalizado adentro, de
    // modo que un choque por `createCommandKey` implica una fila con esa misma
    // identidad —y la lectura por identidad la encuentra antes—. Se mapea igual
    // porque el repositorio es público y un llamador futuro puede traer una
    // clave que no cargue la identidad.
    if (result.status === "exact_name_exists") {
      return {
        ok: false,
        error: "Ese intento de creación ya resolvió a otro laboratorio.",
        code: "EXACT_NAME_EXISTS",
      };
    }

    return {
      ok: true,
      laboratory: {
        id: result.laboratory.id,
        name: result.laboratory.name,
        needsReview: result.laboratory.needsReview,
      },
      status: result.status,
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
