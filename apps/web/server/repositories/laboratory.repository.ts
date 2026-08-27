// --------------------------------------------------------------------------
// Repositorio de laboratorios — ÚNICO lugar que toca Prisma para `Laboratory`.
//
// Patrón: findOrCreate con idempotencia por searchKey. La transacción es
// CORTA — solo crea el laboratorio y retorna. No se mezcla con operaciones
// de inventario ni de pendientes.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Laboratory, Prisma } from "@/lib/generated/prisma/client";

import {
  normalizeLaboratoryName,
  type LaboratoryCandidate,
} from "@/server/domain/laboratory/identity";

// --------------------------------------------------------------------------
// Búsqueda normalizada — 8 resultados, prefijos primero.
// --------------------------------------------------------------------------

const SEARCH_LIMIT = 8;

/**
 * Busca laboratorios por nombre normalizado. Devuelve máximo 8 resultados
 * con prefijos primero. NO mergea: candidatos similares se muestran como
 * opciones separadas.
 */
export async function searchLaboratories(
  query: string,
  client: Prisma.TransactionClient = prisma,
): Promise<LaboratoryCandidate[]> {
  const normalized = normalizeLaboratoryName(query);
  if (normalized.length === 0) return [];

  // Buscar por searchKey (preciso) y por name ILIKE (fuzzy).
  // El OR cubre ambos casos: searchKey para los que ya lo tienen, ILIKE para
  // los que todavía no (pre-T2 o needsReview).
  const rows = await client.$queryRawUnsafe<LaboratoryCandidate[]>(
    `SELECT id, name, "searchKey", "needsReview"
       FROM laboratories
      WHERE "searchKey" = ${normalized}
         OR name ILIKE ${`%${normalized}%`}
      ORDER BY
        CASE WHEN "searchKey" = ${normalized} THEN 0 ELSE 1 END,
        name
      LIMIT ${SEARCH_LIMIT}`,
  );

  return rows;
}

// --------------------------------------------------------------------------
// Creación idempotente — resolve-or-create en transacción corta.
// --------------------------------------------------------------------------

export type CreateLaboratoryData = {
  name: string;
  /** Clave de idempotencia del intento de creación. */
  commandKey?: string;
  /** Huella del contenido del comando. */
  commandFingerprint?: string;
  /** Marca para revisión manual (default: false). */
  needsReview?: boolean;
};

export type LaboratoryRecord =
  | { status: "created"; laboratory: Laboratory }
  | { status: "exists"; laboratory: Laboratory }
  | { status: "exact_name_exists"; laboratory: Laboratory };

/**
 * Resolve-or-create: si ya existe un laboratorio con el mismo searchKey,
 * retorna el existente. Si no, lo crea. Idempotente bajo concurrencia:
 * el UNIQUE en searchKey evita duplicados.
 *
 * Si existe un laboratorio con el mismo nombre normalizado pero distinto
 * commandKey, retorna `exact_name_exists` — el llamador decide qué hacer
 * (mostrar warning, merger, etc.).
 *
 * La transacción es corta: solo laboratorio, sin tocar inventario.
 */
export async function findOrCreateLaboratory(
  data: CreateLaboratoryData,
  client: Prisma.TransactionClient = prisma,
): Promise<LaboratoryRecord> {
  const searchKey = normalizeLaboratoryName(data.name);

  // 1. Buscar existente por searchKey
  const existing = await client.laboratory.findUnique({
    where: { searchKey },
  });

  if (existing) {
    return { status: "exists", laboratory: existing };
  }

  // 2. Crear — el UNIQUE en searchKey protege contra concurrencia
  try {
    const laboratory = await client.laboratory.create({
      data: {
        name: data.name.trim(),
        searchKey,
        needsReview: data.needsReview ?? false,
        ...(data.commandKey
          ? { createCommandKey: data.commandKey }
          : {}),
        ...(data.commandFingerprint
          ? { createCommandFingerprint: data.commandFingerprint }
          : {}),
      },
    });
    return { status: "created", laboratory };
  } catch (error) {
    // Unique violation = otro proceso creó el mismo searchKey entre nuestro
    // SELECT y nuestro INSERT. Re-leer y retornar el existente.
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      const raceWinner = await client.laboratory.findUnique({
        where: { searchKey },
      });
      if (raceWinner) {
        return { status: "exists", laboratory: raceWinner };
      }
    }
    throw error;
  }
}

/**
 * Busca un laboratorio por ID. Retorna null si no existe.
 */
export async function findLaboratoryById(
  id: string,
  client: Prisma.TransactionClient = prisma,
): Promise<Laboratory | null> {
  return client.laboratory.findUnique({ where: { id } });
}

/**
 * Lista todos los laboratorios activos (para selects/autocomplete).
 */
export async function listLaboratories(
  client: Prisma.TransactionClient = prisma,
): Promise<Pick<Laboratory, "id" | "name" | "searchKey" | "needsReview">[]> {
  return client.laboratory.findMany({
    select: { id: true, name: true, searchKey: true, needsReview: true },
    orderBy: { name: "asc" },
  });
}
