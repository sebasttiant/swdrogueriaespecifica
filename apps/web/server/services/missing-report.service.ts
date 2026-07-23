import { normalizeMissingReportName } from "@/features/faltantes/missing-report-name";
import { createMissingReport } from "@/server/repositories/missing-report.repository";

export type SubmitMissingReportInput = {
  // Nombre tal cual lo pegó el vendedor desde Orión. Se conserva para mostrar.
  rawName: string;
  // Siempre desde la sesión en la capa de acción; el service no lo deriva.
  reporterId: string;
};

// El nombre pasó la validación de Zod (presencia + longitud) pero al normalizar
// quedó vacío: p. ej. solo caracteres de control, que `trim` no elimina. Es un
// error de validación de dominio, no un fallo de infraestructura; la acción lo
// mapea a un mensaje para el vendedor y NO persiste nada.
export class MissingReportEmptyNameError extends Error {
  constructor() {
    super("Missing report name is empty after normalization");
    this.name = "MissingReportEmptyNameError";
  }
}

// Registra un reporte provisional: normaliza el nombre para poder agrupar
// reportes del mismo producto más adelante, conservando el nombre original.
// No crea Product ni MissingItem, no maneja cantidades ni proveedores: es solo
// la observación "esto falta", pendiente de revisión de gerencia.
export async function submitMissingReport(input: SubmitMissingReportInput) {
  const normalizedName = normalizeMissingReportName(input.rawName);
  if (normalizedName === "") throw new MissingReportEmptyNameError();

  return createMissingReport({
    rawName: input.rawName,
    normalizedName,
    reporterId: input.reporterId,
  });
}
