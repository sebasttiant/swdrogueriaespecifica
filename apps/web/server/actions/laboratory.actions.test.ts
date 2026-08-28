import { beforeEach, describe, expect, it, vi } from "vitest";

// Aislamos la action: el foco es el MAPEO del resultado del repositorio, no la
// regla de identidad —esa se prueba contra PostgreSQL real en
// `tests/postgres/laboratory-repository.pg.test.ts`—.
//
// El repositorio se mockea porque importar el de verdad arrastra el singleton
// de Prisma, que exige `AUTH_SECRET`.
const { getCurrentSession, findOrCreateLaboratory, searchLaboratories } =
  vi.hoisted(() => ({
    getCurrentSession: vi.fn(),
    findOrCreateLaboratory: vi.fn(),
    searchLaboratories: vi.fn(),
  }));

vi.mock("@/lib/auth/index.node", () => ({ getCurrentSession }));
vi.mock("@/server/repositories/laboratory.repository", () => ({
  findOrCreateLaboratory,
  searchLaboratories,
}));

import { createLaboratoryAction } from "@/server/actions/laboratory.actions";

const LAB = { id: "lab-1", name: "MK Pharma", needsReview: false };

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentSession.mockResolvedValue({ user: { id: "user-1" } });
});

describe("createLaboratoryAction · mapeo del resultado", () => {
  it("propaga created", async () => {
    findOrCreateLaboratory.mockResolvedValue({
      status: "created",
      laboratory: LAB,
    });

    const result = await createLaboratoryAction("MK Pharma");

    expect(result).toMatchObject({ ok: true, status: "created" });
  });

  it("propaga exists", async () => {
    findOrCreateLaboratory.mockResolvedValue({
      status: "exists",
      laboratory: LAB,
    });

    const result = await createLaboratoryAction("MK Pharma");

    expect(result).toMatchObject({ ok: true, status: "exists" });
  });

  // El defecto: `exact_name_exists` se aplastaba a `exists` y la action
  // devolvía `ok: true` con un laboratorio de OTRO nombre. La pantalla hace
  // `setQuery(result.laboratory.name)`, así que le cambiaba al operador el
  // texto que había tipeado por uno que nunca escribió.
  it("NO da por bueno exact_name_exists ni filtra el laboratorio ajeno", async () => {
    findOrCreateLaboratory.mockResolvedValue({
      status: "exact_name_exists",
      laboratory: { id: "otro", name: "Genfar", needsReview: false },
    });

    const result = await createLaboratoryAction("MK Pharma");

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "EXACT_NAME_EXISTS" });
    expect(JSON.stringify(result)).not.toContain("Genfar");
  });

  it("rechaza sin sesión y no toca el repositorio", async () => {
    getCurrentSession.mockResolvedValue(null);

    const result = await createLaboratoryAction("MK Pharma");

    expect(result.ok).toBe(false);
    expect(findOrCreateLaboratory).not.toHaveBeenCalled();
  });
});
