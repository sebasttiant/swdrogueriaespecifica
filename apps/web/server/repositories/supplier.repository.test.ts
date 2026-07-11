import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    supplier: {
      findMany: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { listSuppliers } from "./supplier.repository";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.supplier.findMany.mockResolvedValue([]);
});

describe("listSuppliers", () => {
  // El selector es un desplegable: se ordena por nombre, no por fecha de alta,
  // porque el operador busca al proveedor por su nombre.
  it("ordena los proveedores por nombre", async () => {
    await listSuppliers();

    const args = prismaMock.supplier.findMany.mock.calls[0]![0];
    expect(args.orderBy).toEqual({ name: "asc" });
  });

  // Solo lo que el selector necesita: nada de teléfono, dirección ni email, que
  // son datos de contacto y no tienen por qué viajar al cliente para elegir.
  it("selecciona solo id y nombre, sin datos de contacto", async () => {
    await listSuppliers();

    const args = prismaMock.supplier.findMany.mock.calls[0]![0];
    expect(args.select).toEqual({ id: true, name: true });
  });

  it("devuelve las filas del proveedor tal cual", async () => {
    prismaMock.supplier.findMany.mockResolvedValue([
      { id: "sup-1", name: "Distribuidora Norte" },
    ]);

    await expect(listSuppliers()).resolves.toEqual([
      { id: "sup-1", name: "Distribuidora Norte" },
    ]);
  });
});
