import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/lib/generated/prisma/client";
import { deriveReservedBatchCode } from "@/lib/inventory/reserved-batch-code";
import { EXPIRY_TIERS } from "@/lib/inventory/batch-status";

import { expiryTierWhere, upsertBatchQuantity } from "./product-batch.repository";

// --------------------------------------------------------------------------
// Los dos invariantes de `product_batches` que no dependen de la base.
//
//   1. El código reservado solo lo escribe el sistema, y solo con el
//      vencimiento que le corresponde.
//   2. Un vencimiento DESCONOCIDO no entra en ninguna franja de aviso.
//
// El primero se prueba contra el chokepoint —`upsertBatchQuantity`, el único
// lugar por el que pasa toda escritura de `batchCode` del servicio— con un
// cliente de mentira: lo que se afirma es que RECHAZA antes de escribir, y para
// eso no hace falta PostgreSQL.
// --------------------------------------------------------------------------

/** Un `TransactionClient` que solo registra el upsert que se le pidió. */
function clienteFalso() {
  const upsert = vi.fn().mockResolvedValue({ id: "lote-1" });
  return {
    client: { productBatch: { upsert } } as unknown as Prisma.TransactionClient,
    upsert,
  };
}

const ENERO_15 = new Date("2027-01-15T05:00:00.000Z"); // 00:00 Bogotá
const FEBRERO_20 = new Date("2027-02-20T05:00:00.000Z");

function entrada(batchCode: string, expiresAt: Date | null) {
  return { productId: "prod-1", batchCode, expiresAt, quantity: 5 };
}

describe("upsertBatchQuantity · el código reservado está protegido", () => {
  it("acepta el código derivado para SU vencimiento", async () => {
    const { client, upsert } = clienteFalso();

    await upsertBatchQuantity(
      client,
      entrada(deriveReservedBatchCode(ENERO_15), ENERO_15),
    );

    expect(upsert).toHaveBeenCalledOnce();
  });

  it("acepta la forma pelada cuando NO hay vencimiento", async () => {
    const { client, upsert } = clienteFalso();

    await upsertBatchQuantity(client, entrada(deriveReservedBatchCode(null), null));

    expect(upsert).toHaveBeenCalledOnce();
  });

  it("rechaza la forma con fecha si la fecha NO es la del lote", async () => {
    const { client, upsert } = clienteFalso();

    await expect(
      upsertBatchQuantity(client, entrada("SIN LOTE 2027-01-15", FEBRERO_20)),
    ).rejects.toThrow(/reserv/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rechaza la forma pelada cuando SÍ hay vencimiento", async () => {
    const { client, upsert } = clienteFalso();

    await expect(
      upsertBatchQuantity(client, entrada("SIN LOTE", ENERO_15)),
    ).rejects.toThrow(/reserv/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rechaza la forma con fecha cuando NO hay vencimiento", async () => {
    const { client, upsert } = clienteFalso();

    await expect(
      upsertBatchQuantity(client, entrada("SIN LOTE 2027-01-15", null)),
    ).rejects.toThrow(/reserv/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  // Un guion que escriba el código a mano lo va a escribir como se le ocurra.
  // Se guarda la forma canónica o no se guarda: dos escrituras que se leen
  // igual pero se guardan distinto son dos lotes donde tiene que haber uno.
  it("rechaza una variante que se lee igual pero no es la canónica", async () => {
    const { client, upsert } = clienteFalso();

    await expect(
      upsertBatchQuantity(client, entrada("sin lote 2027-01-15", ENERO_15)),
    ).rejects.toThrow(/reserv/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("no se mete con un código real", async () => {
    const { client, upsert } = clienteFalso();

    await upsertBatchQuantity(client, entrada("SIN LOTES DEL PROVEEDOR", null));
    await upsertBatchQuantity(client, entrada("L-2027-001", ENERO_15));

    expect(upsert).toHaveBeenCalledTimes(2);
  });
});

describe("expiryTierWhere · lo desconocido no vence", () => {
  // Un lote sin fecha no es un aviso: nadie sabe cuándo vence, así que no hay
  // nada que anunciar. El `IS NOT NULL` va explícito y no confiado a la lógica
  // de tres valores de SQL, para que la intención sobreviva a una reescritura.
  it.each(EXPIRY_TIERS)("la franja %s excluye los lotes sin fecha", (tier) => {
    expect(expiryTierWhere(tier)).toMatchObject({ expiresAt: { not: null } });
  });
});
