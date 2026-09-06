import { describe, expect, it } from "vitest";

import { EXPIRY_TIERS } from "@/lib/inventory/batch-status";

import {
  EXPIRY_TIER_EMPTY,
  EXPIRY_TIER_LABELS,
  EXPIRY_TIER_TONE,
  VENCIMIENTOS_PATH,
  expiryCountdownLabel,
  resolveExpiryTier,
  vencimientosHref,
} from "./expiry-tier";

describe("resolveExpiryTier", () => {
  it.each(EXPIRY_TIERS)("accepts the known tier %s", (tier) => {
    expect(resolveExpiryTier(tier)).toBe(tier);
  });

  // El parámetro es input del usuario y viaja a una consulta: un valor
  // inventado no puede romper la pantalla ni abrir una franja que no existe.
  it.each([undefined, null, "", "ok", "vencidos", "../../etc", "EXPIRED"])(
    "falls back to the most urgent tier for %p",
    (raw) => {
      expect(resolveExpiryTier(raw)).toBe("expired");
    },
  );
});

describe("vencimientosHref", () => {
  it("always names the tier, so the link is never ambiguous", () => {
    expect(vencimientosHref({ tier: "critical" })).toBe(
      `${VENCIMIENTOS_PATH}?tier=critical`,
    );
  });

  it("carries the cursor when paging", () => {
    expect(vencimientosHref({ tier: "warning", cursor: "abc123" })).toBe(
      `${VENCIMIENTOS_PATH}?tier=warning&cursor=abc123`,
    );
  });

  // Se prueba el IDA Y VUELTA, no una codificación literal: `URLSearchParams`
  // escribe el espacio como "+" y eso decodifica a espacio igual. Fijar los
  // bytes acá ataría el test a un detalle del codificador, no al contrato.
  it("escapes the cursor so it survives the round trip", () => {
    const cursor = "a b&c=d";
    const href = vencimientosHref({ tier: "expired", cursor });
    const parsed = new URLSearchParams(href.split("?")[1]);

    expect(parsed.get("cursor")).toBe(cursor);
    expect(parsed.get("tier")).toBe("expired");
  });

  it("omits an empty cursor instead of emitting a dangling param", () => {
    expect(vencimientosHref({ tier: "expired", cursor: null })).toBe(
      `${VENCIMIENTOS_PATH}?tier=expired`,
    );
  });
});

describe("tier vocabulary", () => {
  // Una franja sin etiqueta, sin tono o sin mensaje de vacío se pinta rota
  // recién en producción. Que el test lo diga acá.
  it.each(EXPIRY_TIERS)("%s has a label, a tone and an empty state", (tier) => {
    expect(EXPIRY_TIER_LABELS[tier]).toBeTruthy();
    expect(EXPIRY_TIER_TONE[tier]).toBeTruthy();
    expect(EXPIRY_TIER_EMPTY[tier].title).toBeTruthy();
    expect(EXPIRY_TIER_EMPTY[tier].description).toBeTruthy();
  });
});

describe("expiryCountdownLabel", () => {
  it.each([
    [-10, "Venció hace 10 días"],
    [-1, "Venció ayer"],
    [0, "Vence hoy"],
    [1, "Vence mañana"],
    [12, "Faltan 12 días"],
    [90, "Faltan 90 días"],
  ])("reads %p as %p", (days, expected) => {
    expect(expiryCountdownLabel(days)).toBe(expected);
  });

  // Lo vencido nunca se muestra con un signo menos: el lector no tiene que
  // interpretar aritmética para saber que ese lote ya no se puede vender.
  it("never shows a minus sign", () => {
    for (const days of [-1, -2, -30, -365]) {
      expect(expiryCountdownLabel(days)).not.toContain("-");
    }
  });
});
