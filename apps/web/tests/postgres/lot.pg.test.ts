import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  createLot,
  findLotById,
  LotIdentityConflictError,
} from "@/server/repositories/lot.repository";

// Estas pruebas corren contra PostgreSQL real (harness de T0.2): que el índice
// único y el check de no-negatividad rechacen de verdad es algo que solo la
// base puede decir. Un doble de prueba diría que sí a cualquier cosa.

const AT = new Date("2026-08-15T12:00:00Z");
const day = (offset: number) => new Date(AT.getTime() + offset * 86_400_000);

let productId = "";
let otherProductId = "";
let lotSeq = 0;

function nextLotNumber(): string {
  lotSeq += 1;
  return `L-${lotSeq}-${Date.now()}`;
}

async function newProduct(name: string): Promise<string> {
  const product = await prisma.product.create({
    data: { code: `LOT-${name}-${Date.now()}`, name, unit: "unidad" },
  });
  return product.id;
}

beforeAll(async () => {
  productId = await newProduct("Ibuprofeno");
  otherProductId = await newProduct("Amoxicilina");
});

afterEach(async () => {
  await prisma.lot.deleteMany({ where: { productId: { in: [productId, otherProductId] } } });
});

describe("createLot", () => {
  it("persiste el lote con su cantidad, vencimiento y recepción", async () => {
    const lot = await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt: day(30),
      onHand: 12,
      receivedAt: AT,
      location: "Estante A",
    });

    expect(lot.onHand).toBe(12);
    expect(lot.status).toBe("AVAILABLE");
    expect(lot.expiresAt?.toISOString()).toBe(day(30).toISOString());
    expect(lot.receivedAt.toISOString()).toBe(AT.toISOString());
    expect((await findLotById(lot.id))?.id).toBe(lot.id);
  });

  // Un lote sin vencimiento es válido: no todo lo que entra a la droguería
  // vence, y obligarlo llevaría a inventar fechas.
  it("acepta un lote sin vencimiento", async () => {
    const lot = await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt: null,
      onHand: 5,
    });

    expect(lot.expiresAt).toBeNull();
  });

  it("acepta un lote agotado, con cantidad cero", async () => {
    const lot = await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt: day(10),
      onHand: 0,
    });

    expect(lot.onHand).toBe(0);
  });

  // La identidad del lote es (producto, número de lote). Repetirla no se
  // reintenta: es un conflicto real y quien llama tiene que decidir qué hacer.
  it("rechaza repetir el número de lote del mismo producto, sin duplicar la fila", async () => {
    const lotNumber = nextLotNumber();
    await createLot({ productId, lotNumber, expiresAt: day(20), onHand: 3 });

    const conflict = await createLot({
      productId,
      lotNumber,
      expiresAt: day(40),
      onHand: 7,
    }).catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(LotIdentityConflictError);
    expect(await prisma.lot.count({ where: { productId, lotNumber } })).toBe(1);
  });

  it("permite el mismo número de lote en otro producto", async () => {
    const lotNumber = nextLotNumber();
    await createLot({ productId, lotNumber, expiresAt: day(20), onHand: 3 });

    const other = await createLot({
      productId: otherProductId,
      lotNumber,
      expiresAt: day(20),
      onHand: 3,
    });

    expect(other.productId).toBe(otherProductId);
  });

  // La no-negatividad la sostiene la BASE, no solo el código: es la red que
  // atrapa cualquier sobre-descuento futuro, venga de donde venga.
  it("rechaza una cantidad negativa y no deja fila", async () => {
    const lotNumber = nextLotNumber();

    const failure = await createLot({
      productId,
      lotNumber,
      expiresAt: day(15),
      onHand: -1,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(await prisma.lot.count({ where: { productId, lotNumber } })).toBe(0);
  });

  it("la base rechaza una cantidad negativa aunque no pase por el repositorio", async () => {
    const failure = await prisma.lot
      .create({
        data: { productId, lotNumber: nextLotNumber(), onHand: -5 },
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
  });
});
