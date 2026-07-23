import { bogotaDayKey, parseBogotaWallTime } from "@/lib/datetime/bogota";

// Un pendiente siempre es para el día o, como mucho, 24 horas: el compromiso de
// entrega vive dentro de esa ventana. En vez de obligar a abrir el date picker
// del celular (lento, el 90% del uso es móvil), se ofrecen atajos que cubren el
// 95% de los casos. El caso raro (otra fecha) usa el `datetime-local` de siempre.
//
// El valor es una hora de PARED de Bogotá en formato `datetime-local`
// (`YYYY-MM-DDTHH:mm`): exactamente el mismo contrato que ya consume el schema
// (`parseBogotaWallTime`). El backend no cambia.

export type PromisedAtOption = {
  key: string;
  label: string;
  value: string;
  // El instante ya pasó: ofrecerlo daría una promesa vencida de entrada.
  disabled: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildPromisedAtOptions(now: Date = new Date()): PromisedAtOption[] {
  const todayKey = bogotaDayKey(now);
  // Colombia no tiene horario de verano (UTC-5 fijo), así que sumar 24 h y tomar
  // la clave de día de Bogotá siempre cae en "mañana".
  const tomorrowKey = bogotaDayKey(new Date(now.getTime() + DAY_MS));

  const raw = [
    { key: "today-18", label: "Hoy antes de las 18:00", value: `${todayKey}T18:00` },
    { key: "tomorrow-12", label: "Mañana antes de las 12:00", value: `${tomorrowKey}T12:00` },
    { key: "tomorrow-18", label: "Mañana antes de las 18:00", value: `${tomorrowKey}T18:00` },
  ];

  return raw.map((option) => {
    const target = parseBogotaWallTime(option.value);
    const disabled = target === null || target.getTime() <= now.getTime();
    return { ...option, disabled };
  });
}

// Valor por defecto al abrir el form: "Hoy 18:00" es el caso más común; si ya
// pasó, la primera opción disponible (Mañana 12:00).
export function defaultPromisedAtValue(now: Date = new Date()): string {
  const options = buildPromisedAtOptions(now);
  const firstAvailable = options.find((option) => !option.disabled);
  return (firstAvailable ?? options[options.length - 1]!).value;
}
