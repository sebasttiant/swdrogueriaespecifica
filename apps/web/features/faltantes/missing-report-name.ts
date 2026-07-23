const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

export function normalizeMissingReportName(rawName: string): string {
  return rawName
    .normalize("NFC")
    .replace(CONTROL_CHARACTERS, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
