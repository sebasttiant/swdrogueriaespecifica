import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

// --------------------------------------------------------------------------
// Contraste de los tokens del tema, MEDIDO — no supuesto.
//
// Existe porque el bloque oscuro afirmaba por comentario que danger y success
// "ya contrastan contra el fondo oscuro" y era FALSO: danger daba 3.18:1 sobre
// la tarjeta, por debajo del 4.5:1 que WCAG AA pide para texto normal, en las
// 56 pantallas que usan `text-danger`. Una afirmación de contraste escrita a
// mano no vale nada y encima envejece sola; ésta se calcula.
//
// Se mide contra la SUPERFICIE y no contra el fondo de la página: es donde vive
// casi todo el texto de la app.
// --------------------------------------------------------------------------

/** Los tres canales de un `#rrggbb`, cada uno en 0..255. */
function channels(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/** Luminancia relativa WCAG de un color `#rrggbb`. */
function relativeLuminance(hex: string): number {
  const { r, g, b } = channels(hex);
  const toLinear = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Razón de contraste WCAG. Simétrica: el orden de los colores no importa. */
function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Composición de un color translúcido sobre un fondo opaco.
 *
 * Los estados casi nunca se pintan sólidos: se usan como `bg-danger/10` con
 * `text-danger` encima. Medir el texto contra la superficie desnuda daría un
 * número optimista, porque el tinte del propio color acerca el fondo al texto.
 * Es el caso de "Venció hace 31 días".
 */
function over(foreground: string, background: string, alpha: number): string {
  const f = channels(foreground);
  const b = channels(background);
  const blend = (front: number, back: number) =>
    Math.round(front * alpha + back * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  return `#${blend(f.r, b.r)}${blend(f.g, b.g)}${blend(f.b, b.b)}`;
}

/** Mínimo de WCAG AA para texto normal. */
const AA_NORMAL_TEXT = 4.5;

/** Opacidades con las que la app tiñe fondos de estado (`bg-danger/10`, `/20`). */
const STATE_TINTS = [0.1, 0.2];

function readGlobals(): Promise<string> {
  return readFile(new URL("./globals.css", import.meta.url), "utf8");
}

/** Los tokens de un selector dentro del tramo de CSS que se le pase. */
function tokensOf(css: string, selector: string): string {
  return css.match(new RegExp(`${selector}\\s*\\{(?<tokens>[^}]*)}`))?.groups?.tokens ?? "";
}

/** El valor de un token dentro de un bloque ya extraído. */
function valueOf(block: string, token: string): string {
  return block.match(new RegExp(`${token}:\\s*(?<value>#[0-9a-f]{6});`))?.groups?.value ?? "";
}

type Theme = { light: string; dark: string; print: string };

async function readTheme(): Promise<Theme> {
  const css = await readGlobals();
  const printAt = css.indexOf("@media print {");
  return {
    light: tokensOf(css, "@theme"),
    // El bloque oscuro de PANTALLA es el primero, antes del `@media print`.
    dark: tokensOf(css.slice(0, printAt), '\\[data-theme="dark"]'),
    print: tokensOf(css.slice(printAt), '\\[data-theme="dark"]'),
  };
}

/**
 * Lo que el usuario ve en oscuro: el override si existe, y si no el valor claro
 * heredado. Un token que el bloque oscuro NO redefine sigue estando en pantalla,
 * así que también tiene que medirse. Ese es justo el caso que se había escapado.
 */
function effectiveDark(theme: Theme, token: string): string {
  return valueOf(theme.dark, token) || valueOf(theme.light, token);
}

describe("dark theme contrast", () => {
  it("keeps every state color legible on the dark surface", async () => {
    const theme = await readTheme();
    const surface = effectiveDark(theme, "--color-surface");

    for (const token of ["--color-danger", "--color-success", "--color-warning"]) {
      const value = effectiveDark(theme, token);
      expect(
        contrastRatio(value, surface),
        `${token} (${value}) sobre ${surface}`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it("keeps state text legible on its own tinted background", async () => {
    const theme = await readTheme();
    const surface = effectiveDark(theme, "--color-surface");

    for (const token of ["--color-danger", "--color-success", "--color-warning"]) {
      const value = effectiveDark(theme, token);
      for (const alpha of STATE_TINTS) {
        expect(
          contrastRatio(value, over(value, surface, alpha)),
          `${token} (${value}) sobre su propio fondo al ${alpha * 100}%`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    }
  });

  it("keeps text on solid state buttons legible", async () => {
    const theme = await readTheme();

    // `button.tsx` pinta la variante destructiva como `bg-danger` con
    // `text-danger-foreground` encima: aclarar el rojo sin voltear su
    // foreground dejaría texto blanco sobre rosa.
    expect(
      contrastRatio(
        effectiveDark(theme, "--color-danger-foreground"),
        effectiveDark(theme, "--color-danger"),
      ),
      "danger-foreground sobre danger sólido",
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("keeps body and secondary text legible on the dark surface", async () => {
    const theme = await readTheme();
    const surface = effectiveDark(theme, "--color-surface");

    for (const token of ["--color-text", "--color-muted-foreground", "--color-primary"]) {
      expect(
        contrastRatio(effectiveDark(theme, token), surface),
        `${token} sobre ${surface}`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  // La profundidad en oscuro NO la hacen las sombras —una sombra negra sobre
  // fondo casi negro no se ve—: la hace la luminosidad. Con escalones planos la
  // tarjeta no se despega del fondo y la pantalla entera se lee como una mancha.
  it("separates the surface layers enough to read as depth", async () => {
    const theme = await readTheme();
    const background = effectiveDark(theme, "--color-background");
    const surface = effectiveDark(theme, "--color-surface");
    const muted = effectiveDark(theme, "--color-muted");

    expect(contrastRatio(background, surface), "fondo -> tarjeta").toBeGreaterThanOrEqual(1.3);
    expect(contrastRatio(surface, muted), "tarjeta -> muted").toBeGreaterThanOrEqual(1.3);
  });
});

describe("danger-solid token pair", () => {
  // El relleno pleno de las alertas de peligro (`bg-danger-solid` +
  // `text-danger-solid-foreground`) tiene que cumplir AA por sí solo: es el
  // par que reemplaza al tinte `bg-danger/10` + `text-danger`, que en claro
  // medía 4.13:1 —por debajo del mínimo— y en oscuro solo se salvaba
  // aclarando el rojo hasta perder la urgencia.
  it("keeps the solid foreground legible on the solid danger fill", async () => {
    const css = await readGlobals();
    const light = tokensOf(css, "@theme");
    const fill = valueOf(light, "--color-danger-solid");
    const foreground = valueOf(light, "--color-danger-solid-foreground");

    expect(contrastRatio(foreground, fill), `foreground (${foreground}) sobre fill (${fill})`).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });

  // La gracia del par es que NO cambia entre temas: el mismo rojo se ve
  // igual de urgente en claro, en oscuro y en papel. Si alguien lo
  // redefiniera en `[data-theme="dark"]` o en `@media print` —"arreglando"
  // el par por reflejo, como se hizo con `--color-danger`—, este test tiene
  // que romperse para avisarlo.
  it("is not redefined for dark theme or print", async () => {
    const theme = await readTheme();

    for (const token of ["--color-danger-solid", "--color-danger-solid-foreground"]) {
      expect(valueOf(theme.dark, token), `${token} redefinido en oscuro`).toBe("");
      expect(valueOf(theme.print, token), `${token} redefinido en impresión`).toBe("");
    }
  });
});

describe("print theme tokens", () => {
  it("restores the light warning foreground for dark-theme print output", async () => {
    const { print } = await readTheme();

    expect(print).toContain("--color-warning-foreground: #3a2a00;");
  });

  // LA TRAMPA. Los estados aclarados para oscuro son ilegibles sobre papel
  // blanco (el rojo cae a 2.15:1). Todo token que el bloque oscuro aclare tiene
  // que volver a su valor claro para imprimir, o la hoja sale con texto pálido.
  // Se comprueba en bucle y no a mano para que aclarar un estado nuevo mañana
  // rompa el test en vez de romper el papel.
  it("restores every lightened token for dark-theme print output", async () => {
    const theme = await readTheme();
    const printed = ["--color-danger", "--color-danger-foreground", "--color-success", "--color-warning"];

    for (const token of printed) {
      const dark = valueOf(theme.dark, token);
      if (!dark) continue;
      const light = valueOf(theme.light, token);
      expect(
        contrastRatio(dark, "#ffffff") >= AA_NORMAL_TEXT || theme.print.includes(`${token}: ${light};`),
        `${token} se aclara en oscuro (${dark}) y no se restaura a ${light} para imprimir`,
      ).toBe(true);
    }
  });
});
