#!/usr/bin/env node
// ==========================================================================
// Verifica que el toolchain sea el esperado (Node + pnpm). Si no, imprime la
// solución exacta y sale con código != 0. No modifica nada del sistema.
//
//   node scripts/check-toolchain.mjs   (o  pnpm check:toolchain)
// ==========================================================================
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// LAS VERSIONES SE LEEN DE SU FUENTE DE VERDAD, no se copian acá.
//
// Antes estaban escritas a mano en este archivo, y el 25/10/2026 eso costó un
// CI rojo: se actualizó Node en `.nvmrc`, en `engines` y en el Dockerfile, pero
// esta constante quedó en la versión vieja. El guión que existe para detectar
// un toolchain incoherente era, él mismo, parte de la incoherencia — y encima
// su mensaje de error decía "ver .nvmrc" mientras comparaba contra otra cosa.
//
// Derivarlas elimina la clase entera de error: un bump toca `.nvmrc` y
// `packageManager`, y este chequeo lo sigue solo.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function leer(archivo, descripcion, transformar) {
  let crudo;
  try {
    crudo = readFileSync(join(ROOT, archivo), "utf8");
  } catch {
    console.error(`\x1b[31m✗\x1b[0m No se pudo leer ${archivo}, que define ${descripcion}.`);
    process.exit(1);
  }
  const valor = transformar(crudo);
  if (!valor) {
    console.error(`\x1b[31m✗\x1b[0m ${archivo} no declara ${descripcion} en el formato esperado.`);
    process.exit(1);
  }
  return valor;
}

const REQUIRED_NODE = leer(".nvmrc", "la versión de Node", (s) => s.trim() || null);
const REQUIRED_PNPM = leer(
  "package.json",
  "la versión de pnpm (campo `packageManager`)",
  // `packageManager` puede traer el hash de integridad: `pnpm@12.4.1+sha512...`.
  // Solo interesa la versión, que es lo que imprime `pnpm -v`.
  (s) => JSON.parse(s).packageManager?.match(/^pnpm@([^+\s]+)/)?.[1] ?? null,
);

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

let problems = 0;

const nodeVersion = process.versions.node;
if (nodeVersion === REQUIRED_NODE) {
  console.log(`${green("✓")} Node ${nodeVersion}`);
} else {
  console.error(`${red("✗")} Node ${nodeVersion} (esperado ${REQUIRED_NODE}; usá \`nvm use\`, ver .nvmrc)`);
  problems++;
}

let pnpmVersion = "";
try {
  pnpmVersion = execSync("pnpm -v", { encoding: "utf8" }).trim();
} catch {
  console.error(`${red("✗")} pnpm no está disponible en el PATH`);
  problems++;
}

if (pnpmVersion === REQUIRED_PNPM) {
  console.log(`${green("✓")} pnpm ${pnpmVersion}`);
} else if (pnpmVersion) {
  console.error(`${red("✗")} pnpm ${pnpmVersion} (esperado ${REQUIRED_PNPM})`);
  problems++;
}

if (problems > 0) {
  console.error(
    [
      "",
      "Solución reproducible (no toca config global):",
      "  corepack enable",
      `  corepack prepare pnpm@${REQUIRED_PNPM} --activate`,
      '  export PATH="$(dirname "$(command -v corepack)"):$PATH"   # prioriza el pnpm de Corepack',
      `  pnpm -v   # debe imprimir ${REQUIRED_PNPM}`,
      "",
      "O directamente:  ./scripts/bootstrap.sh",
      "",
      `Por qué pasa: un pnpm global más viejo intenta auto-provisionar ${REQUIRED_PNPM} con la`,
      "config GLOBAL (minimumReleaseAge) y puede quedar bloqueado. Corepack lo evita.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(green("\nToolchain OK."));
