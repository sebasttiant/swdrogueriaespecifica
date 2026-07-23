// --------------------------------------------------------------------------
// Repositorio de reportes provisionales de faltante — ÚNICO lugar que toca
// Prisma para `MissingReport`. Un reporte es la observación de un vendedor de
// que un producto (por su nombre) quedó en cero; NO es un Product ni un
// MissingItem canónico. Cada llamada crea una fila independiente: reportes
// repetidos se conservan por separado (no hay unique ni upsert), y no hay
// cantidad que sumar.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";

export type CreateMissingReportData = {
  rawName: string;
  normalizedName: string;
  reporterId: string;
};

export function createMissingReport(data: CreateMissingReportData) {
  return prisma.missingReport.create({
    data: {
      rawName: data.rawName,
      normalizedName: data.normalizedName,
      reporterId: data.reporterId,
    },
  });
}
