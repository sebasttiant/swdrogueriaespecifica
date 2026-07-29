#!/usr/bin/env node
// ==========================================================================
// Verifica que el toolchain sea el esperado (Node + pnpm). Si no, imprime la
// solución exacta y sale con código != 0. No modifica nada del sistema.
//
//   node scripts/check-toolchain.mjs   (o  pnpm check:toolchain)
// ==========================================================================
import { execSync } from "node:child_process";

const REQUIRED_NODE = "24.18.0";
const REQUIRED_PNPM = "11.18.0";

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
      "Por qué pasa: un pnpm global más viejo intenta auto-provisionar 11.10.0 con la",
      "config GLOBAL (minimumReleaseAge) y puede quedar bloqueado. Corepack lo evita.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(green("\nToolchain OK."));
