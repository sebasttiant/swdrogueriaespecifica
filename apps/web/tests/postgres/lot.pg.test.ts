import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  createLot,
  findLotById,
  listEligibleLots,
  LotIdentityConflictError,
} from "@/server/repositories/lot.repository";

// Estas pruebas corren contra PostgreSQL real (harness de T0.2): que el índice
// único, el check de no-negatividad y el orden FEFO con los NULL al final se
// cumplan de verdad es algo que solo la base puede decir. Un doble de prueba
// diría que sí a cualquier cosa, y un sort en memoria no se puede paginar.

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

describe("listEligibleLots", () => {
  // FEFO: primero vence, primero sale. Los lotes sin vencimiento van al final,
  // no al principio: un NULL no es "vence ya".
  it("ordena por vencimiento con los sin vencimiento al final", async () => {
    const sinVencimiento = await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt: null,
      onHand: 1,
    });
    const tarde = await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt: day(60),
      onHand: 1,
    });
    const temprano = await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt: day(10),
      onHand: 1,
    });

    const eligible = await listEligibleLots(productId, AT);

    expect(eligible.map((lot) => lot.id)).toEqual([temprano.id, tarde.id, sinVencimiento.id]);
  });

  // Mismo vencimiento: desempata el que llegó antes, y si empatan, el id. Sin
  // ese desempate el orden sería inestable entre corridas.
  it("desempata por recepción y después por id", async () => {
    const expiresAt = day(10);
    const nuevo = await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt,
      onHand: 1,
      receivedAt: day(-1),
    });
    const viejo = await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt,
      onHand: 1,
      receivedAt: day(-30),
    });

    const eligible = await listEligibleLots(productId, AT);

    expect(eligible.map((lot) => lot.id)).toEqual([viejo.id, nuevo.id]);
  });

  it("deja afuera el lote en cuarentena y el vencido", async () => {
    const disponible = await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt: day(30),
      onHand: 4,
    });
    await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt: day(30),
      onHand: 4,
      status: "QUARANTINED",
    });
    await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt: day(-1),
      onHand: 4,
    });

    const eligible = await listEligibleLots(productId, AT);

    expect(eligible.map((lot) => lot.id)).toEqual([disponible.id]);
  });

  // El vencimiento se DERIVA de la fecha: el mismo lote es elegible antes y
  // deja de serlo después, sin que nadie tenga que actualizar un estado.
  it("el mismo lote deja de ser elegible al pasar su vencimiento", async () => {
    const lot = await createLot({
      productId,
      lotNumber: nextLotNumber(),
      expiresAt: day(5),
      onHand: 2,
    });

    expect((await listEligibleLots(productId, AT)).map((row) => row.id)).toEqual([lot.id]);
    expect(await listEligibleLots(productId, day(6))).toEqual([]);
  });

  it("no mezcla los lotes de otro producto", async () => {
    await createLot({
      productId: otherProductId,
      lotNumber: nextLotNumber(),
      expiresAt: day(1),
      onHand: 9,
    });

    expect(await listEligibleLots(productId, AT)).toEqual([]);
  });
});
