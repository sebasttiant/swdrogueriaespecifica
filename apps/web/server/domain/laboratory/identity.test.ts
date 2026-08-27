import { describe, expect, it } from "vitest";

import {
  assertValidLaboratoryName,
  LaboratoryIdentityError,
  normalizeLaboratoryName,
  rankLaboratoryCandidates,
  type LaboratoryCandidate,
} from "@/server/domain/laboratory/identity";

// --------------------------------------------------------------------------
// Tests del dominio de identidad de laboratorio.
//
// Estos tests NO tocan la base de datos. Verifican las reglas puras:
// normalización, validación, ranking de candidatos.
// --------------------------------------------------------------------------

describe("normalizeLaboratoryName", () => {
  it("normaliza a minúsculas", () => {
    expect(normalizeLaboratoryName("BAYER")).toBe("bayer");
  });

  it("recorta espacios extremos", () => {
    expect(normalizeLaboratoryName("  Bayer  ")).toBe("bayer");
  });

  it("colapsa espacios múltiples", () => {
    expect(normalizeLaboratoryName("Bayer  S.A.")).toBe("bayer s.a.");
  });

  it("mismas claves para nombres con puntuación distinta", () => {
    // "Bayer S.A." y "bayer s.a." son la misma clave (el punto es parte del nombre)
    expect(normalizeLaboratoryName("Bayer S.A.")).toBe(
      normalizeLaboratoryName("bayer s.a."),
    );
  });

  it("claves distintas para nombres distintos", () => {
    expect(normalizeLaboratoryName("Bayer")).not.toBe(
      normalizeLaboratoryName("Bayer Chile"),
    );
  });

  it("string vacío resulta en vacío", () => {
    expect(normalizeLaboratoryName("")).toBe("");
    expect(normalizeLaboratoryName("   ")).toBe("");
  });
});

describe("assertValidLaboratoryName", () => {
  it("no lanza con nombre válido", () => {
    expect(() => assertValidLaboratoryName("Bayer")).not.toThrow();
  });

  it("lanza MISSING_NAME con string vacío", () => {
    expect(() => assertValidLaboratoryName("")).toThrow(
      LaboratoryIdentityError,
    );
    expect(() => assertValidLaboratoryName("")).toThrow("MISSING_NAME");
  });

  it("lanza MISSING_NAME con solo espacios", () => {
    expect(() => assertValidLaboratoryName("   ")).toThrow(
      LaboratoryIdentityError,
    );
  });
});

describe("rankLaboratoryCandidates", () => {
  const candidates: LaboratoryCandidate[] = [
    { id: "1", name: "Bayer S.A.", searchKey: "bayer s.a.", needsReview: false },
    { id: "2", name: "Bayer Chile", searchKey: "bayer chile", needsReview: false },
    { id: "3", name: "Genfar", searchKey: "genfar", needsReview: false },
    { id: "4", name: "Bayer Argentina", searchKey: "bayer argentina", needsReview: true },
  ];

  it("prefijos exactos primero", () => {
    const results = rankLaboratoryCandidates(candidates, "bayer");
    expect(results[0]!.name).toBe("Bayer S.A.");
    expect(results[1]!.name).toBe("Bayer Chile");
    expect(results[2]!.name).toBe("Bayer Argentina");
  });

  it("no prefijos van después", () => {
    const results = rankLaboratoryCandidates(candidates, "gen");
    expect(results[0]!.name).toBe("Genfar");
  });

  it("respeta el límite", () => {
    const results = rankLaboratoryCandidates(candidates, "bayer", 2);
    expect(results).toHaveLength(2);
  });

  it("devuelve todos si hay menos que el límite", () => {
    const results = rankLaboratoryCandidates(candidates, "genfar");
    expect(results).toHaveLength(1);
  });

  it("query vacío retorna los primeros 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      name: `Lab ${i}`,
      searchKey: `lab ${i}`,
      needsReview: false,
    }));
    const results = rankLaboratoryCandidates(many, "");
    expect(results).toHaveLength(8);
  });
});
