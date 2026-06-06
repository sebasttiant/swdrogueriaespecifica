// --------------------------------------------------------------------------
// Parseo de hora de pared de Colombia (America/Bogota) → instante UTC.
//
// Un <input type="datetime-local"> manda strings SIN offset ("2026-06-09T14:30").
// `new Date(string)` los interpreta según el timezone del runtime (en Docker
// suele ser UTC), corriendo la hora prometida. Acá anclamos explícitamente a
// Colombia y NO dependemos del timezone del servidor. DST-safe: el offset se
// calcula con Intl, no con un -5 hardcodeado.
// --------------------------------------------------------------------------

const BOGOTA_TIME_ZONE = "America/Bogota";

// Formato de <input type="datetime-local">: YYYY-MM-DDTHH:mm (segundos opcionales).
const DATETIME_LOCAL_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

type WallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

// Componentes de la hora de pared de Colombia para un instante UTC dado.
function bogotaWallTime(instant: number): WallTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BOGOTA_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));

  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function sameWallTime(a: WallTime, b: WallTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * Interpreta `value` (formato datetime-local) como hora de pared de Colombia y
 * devuelve el `Date` con el instante UTC correcto. Devuelve `null` si el string
 * no es un datetime-local válido (formato o componentes fuera de rango).
 *
 * Ej: "2026-06-09T14:30" → 2026-06-09T19:30:00.000Z (Colombia es UTC-5).
 */
export function parseBogotaWallTime(value: string): Date | null {
  const match = DATETIME_LOCAL_RE.exec(value);
  if (!match) return null;

  const input: WallTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
  };

  // Instante "ingenuo": tratamos la hora de pared como si fuera UTC.
  const naiveUtc = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    input.second,
  );
  if (Number.isNaN(naiveUtc)) return null;

  // Offset real de Colombia en ese instante (negativo: UTC-5). Restarlo
  // convierte la hora de pared de Colombia al instante UTC correcto.
  const offsetMs = Date.UTC(...wallTimeToUtcArgs(bogotaWallTime(naiveUtc))) - naiveUtc;
  const utc = new Date(naiveUtc - offsetMs);

  // Round-trip: la hora de pared del resultado en Colombia debe coincidir con la
  // entrada. Esto rechaza fechas que Date.UTC normaliza (ej. 30 de febrero).
  if (!sameWallTime(bogotaWallTime(utc.getTime()), input)) return null;

  return utc;
}

function wallTimeToUtcArgs(
  wall: WallTime,
): [number, number, number, number, number, number] {
  return [
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  ];
}
