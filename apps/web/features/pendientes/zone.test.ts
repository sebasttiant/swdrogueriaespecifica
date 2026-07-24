import { describe, expect, it } from "vitest";

import { normalizeZone } from "./zone";

describe("normalizeZone", () => {
  // La razón de ser del módulo: sin esto el reporte por zona que pide gerencia
  // ve tres zonas donde hay una.
  it("colapsa las variantes de una misma zona en una sola forma", () => {
    const variants = ["norte", "NORTE", "  Norte  ", "nOrTe"];
    const normalized = variants.map((value) => normalizeZone(value));

    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe("Norte");
  });

  it("colapsa los espacios internos", () => {
    expect(normalizeZone("zona    centro")).toBe("Zona Centro");
  });

  it("deja en minúscula los conectores salvo al inicio", () => {
    expect(normalizeZone("BARRIO DE LA CRUZ")).toBe("Barrio de la Cruz");
    expect(normalizeZone("de la cruz")).toBe("De la Cruz");
  });

  it("preserva las tildes de la zona", () => {
    expect(normalizeZone("bogotá occidente")).toBe("Bogotá Occidente");
  });

  it("devuelve null cuando no queda contenido", () => {
    expect(normalizeZone("")).toBeNull();
    expect(normalizeZone("   ")).toBeNull();
  });

  // Caracteres invisibles pegados desde otra app: romperían el agrupado sin que
  // nadie lo vea en pantalla.
  it("descarta caracteres de control en vez de guardarlos", () => {
    expect(normalizeZone("Nor\u0000te")).toBe("Nor Te");
    expect(normalizeZone("\u200B")).toBeNull();
  });
});
