import { describe, expect, it, vi } from "vitest";

import { runSeed, type SeedClient } from "./seed-bootstrap";

// --------------------------------------------------------------------------
// El seed corre en CADA despliegue de producción: `deploy.sh` lo ejecuta entre
// las migraciones y el arranque de la web. Su encabezado, sin embargo, decía
// "seed de desarrollo... un par de productos de ejemplo para tener datos al
// desarrollar", y esos productos de ejemplo terminaron en el catálogo real.
//
// Estas pruebas fijan las dos mitades de lo que el seed SÍ debe hacer —dejar
// existiendo y habilitado al primer SUPERADMIN— y la que NO debe hacer nunca
// más: escribir productos.
//
// Nada de esto tenía cobertura, y es código que se ejecuta contra la base de
// producción cada vez que se despliega.
// --------------------------------------------------------------------------

function fakeClient(admin: { id: string } | null): {
  client: SeedClient;
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  productUpsert: ReturnType<typeof vi.fn>;
  productCreate: ReturnType<typeof vi.fn>;
} {
  const findUnique = vi.fn().mockResolvedValue(admin);
  const update = vi.fn().mockResolvedValue(undefined);
  const create = vi.fn().mockResolvedValue(undefined);
  const productUpsert = vi.fn().mockResolvedValue(undefined);
  const productCreate = vi.fn().mockResolvedValue(undefined);

  return {
    client: {
      user: { findUnique, update, create },
      product: { upsert: productUpsert, create: productCreate },
    } as unknown as SeedClient,
    findUnique,
    update,
    create,
    productUpsert,
    productCreate,
  };
}

const GOOD_PASSWORD = "una-clave-larga-de-verdad";

describe("seed de arranque", () => {
  it("no escribe NINGÚN producto", async () => {
    const fake = fakeClient({ id: "admin-1" });

    await runSeed(fake.client, { email: "admin@ejemplo.com", password: "" });

    expect(fake.productUpsert).not.toHaveBeenCalled();
    expect(fake.productCreate).not.toHaveBeenCalled();
  });

  it("reafirma rol y estado del admin existente, sin tocarle la contraseña", async () => {
    const fake = fakeClient({ id: "admin-1" });

    await runSeed(fake.client, { email: "admin@ejemplo.com", password: GOOD_PASSWORD });

    // Igualdad exacta y no `objectContaining`: la gracia está en lo que NO
    // viaja. La rotación de contraseña se hace desde la aplicación, así que si
    // el seed escribiera `passwordHash` acá, cada despliegue la revertiría en
    // silencio. Un matcher parcial dejaría pasar justo eso.
    expect(fake.update).toHaveBeenCalledWith({
      where: { email: "admin@ejemplo.com" },
      data: { role: "SUPERADMIN", active: true },
    });
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("exige una contraseña larga para CREAR el primer admin", async () => {
    const fake = fakeClient(null);

    await expect(
      runSeed(fake.client, { email: "admin@ejemplo.com", password: "corta" }),
    ).rejects.toThrow(/SEED_ADMIN_PASSWORD/);

    expect(fake.create).not.toHaveBeenCalled();
  });

  it("crea el primer admin como SUPERADMIN cuando no existe", async () => {
    const fake = fakeClient(null);

    await runSeed(fake.client, { email: "admin@ejemplo.com", password: GOOD_PASSWORD });

    expect(fake.create).toHaveBeenCalledWith({
      data: {
        email: "admin@ejemplo.com",
        name: "Super Admin",
        role: "SUPERADMIN",
        // Hasheada, nunca en claro: este repositorio es público.
        passwordHash: expect.not.stringContaining(GOOD_PASSWORD) as unknown as string,
      },
    });
  });
});
