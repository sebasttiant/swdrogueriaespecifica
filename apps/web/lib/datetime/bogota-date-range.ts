// --------------------------------------------------------------------------
// Conversión de un día de calendario colombiano (YYYY-MM-DD, de un
// input[type=date]) a un rango de instantes UTC para queries de base de datos.
//
// Convención de límite superior: EXCLUSIVO inicio del día siguiente.
//   from "2026-06-10" → gte: 2026-06-10T05:00:00.000Z  (medianoche Bogotá)
//   to   "2026-06-10" → lt:  2026-06-11T05:00:00.000Z  (medianoche siguiente)
//
// DST-safe: Colombia no observa DST, pero calculamos el offset con Intl
// en lugar de hardcodear -5, igual que en parseBogotaWallTime.
// --------------------------------------------------------------------------

const BOGOTA_TIME_ZONE = "America/Bogota";

// YYYY-MM-DD regex: formato devuelto por <input type="date">
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

type DateRangeInput = {
  from?: string;
  to?: string;
};

type DateRangeResult = {
  from?: Date;
  to?: Date;
};

/**
 * Convierte un par de strings YYYY-MM-DD (como los de input[type=date]) al
 * rango UTC correspondiente para filtros en Prisma/SQL, anclado a la zona
 * horaria de Colombia (America/Bogota). DST-safe vía Intl.
 *
 * - `from` → `gte` start-of-day Bogotá como UTC (00:00:00 COT).
 * - `to`   → `lt`  start-of-NEXT-day Bogotá como UTC (exclusivo superior).
 * - String vacío o undefined → campo omitido en el resultado.
 */
export function bogotaDayToUtcRange(input: DateRangeInput): DateRangeResult {
  const result: DateRangeResult = {};

  const fromStr = input.from?.trim();
  if (fromStr) {
    const d = parseDayStartBogota(fromStr);
    if (d) result.from = d;
  }

  const toStr = input.to?.trim();
  if (toStr) {
    const d = parseDayStartBogota(toStr, /* nextDay */ true);
    if (d) result.to = d;
  }

  return result;
}

/**
 * Parsea un string YYYY-MM-DD y devuelve el instante UTC que corresponde a las
 * 00:00:00 de ese día en Bogotá. Si `nextDay` es true, avanza un día de
 * calendario (límite superior exclusivo).
 *
 * Retorna null si el string no tiene el formato correcto.
 */
function parseDayStartBogota(value: string, nextDay = false): Date | null {
  const match = DATE_ONLY_RE.exec(value);
  if (!match) return null;

  let year = Number(match[1]);
  let month = Number(match[2]);
  let day = Number(match[3]);

  if (nextDay) {
    // Avanzar un día de calendario — dejamos que Date.UTC normalice el rollover
    // de mes/año (ej. 2026-06-30 + 1 → 2026-07-01, 2025-12-31 + 1 → 2026-01-01).
    day += 1;
  }

  // Instante "ingenuo": interpretamos el día en Bogotá como si fuera UTC.
  // Esto nos da un punto de partida para calcular el offset real de Bogotá.
  const naiveUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  if (Number.isNaN(naiveUtcMs)) return null;

  // Calculamos qué hora de pared muestra Bogotá en ese instante UTC ingenuo.
  // El offset real de Bogotá (ms) es la diferencia entre lo que pusimos y lo
  // que Intl dice que es la hora de pared en Bogotá.
  const bogotaWall = bogotaWallComponents(naiveUtcMs);
  const naiveWallMs = Date.UTC(
    bogotaWall.year,
    bogotaWall.month - 1,
    bogotaWall.day,
    bogotaWall.hour,
    bogotaWall.minute,
    bogotaWall.second,
    0,
  );

  // offsetMs = tiempo extra que hay que restar al "naive UTC" para obtener el
  // instante UTC correcto donde la hora de pared de Bogotá es 00:00:00.
  const offsetMs = naiveWallMs - naiveUtcMs;
  return new Date(naiveUtcMs - offsetMs);
}

type WallComponents = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function bogotaWallComponents(instantMs: number): WallComponents {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BOGOTA_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}
