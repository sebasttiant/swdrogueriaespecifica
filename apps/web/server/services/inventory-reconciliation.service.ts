// --------------------------------------------------------------------------
// Reconciliación de inventario — SOLO LECTURA (T0.3).
//
// Contrasta la proyección `lots.onHand` contra la historia que debería
// explicarla, y señala los lotes donde las dos cuentan cosas distintas.
//
// NO ESCRIBE NADA, y esa es su razón de existir. El verificador que ya había
// (`db:verify` → `verify-fulfillment-invariants.ts`) arranca con `deleteMany`
// sobre media base: sirve para un entorno descartable y para nada más. Este se
// puede correr contra una copia RESTAURADA de producción, que es justo donde
// hace falta mirar antes de un cutover.
//
// Lo que busca son las tres formas en que el inventario puede estar mintiendo:
//
//   COLUMN_DRIFT      la columna dice un número y el ledger dice otro
//   OVERCOMMITTED     se prometió más de lo que hay: disponible negativo
//   NEGATIVE_RESERVED se liberó más de lo que se comprometió
//
// Un lote anterior al ledger aparece como COLUMN_DRIFT y está BIEN que aparezca:
// su stock no lo explica ningún movimiento porque el ledger todavía no existía.
// Esa lista es exactamente el trabajo pendiente del cutover.
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/generated/prisma/client";
import {
  computeActiveReserved,
  computeAvailable,
  computeLedgerOnHand,
} from "@/server/repositories/quantity-derivation.repository";

export type ReconciliationIssue =
  | "COLUMN_DRIFT"
  | "OVERCOMMITTED"
  | "NEGATIVE_RESERVED";

export type LotFinding = {
  lotId: string;
  productId: string;
  lotNumber: string;
  /** Lo que dice la columna. */
  onHand: number;
  /** Lo que suman los movimientos físicos del ledger. */
  ledgerOnHand: number;
  activeReserved: number;
  available: number;
  issues: ReconciliationIssue[];
};

export type ReconciliationReport = {
  checkedLots: number;
  /** Solo los lotes con algo que reportar. Un informe sano viene vacío. */
  findings: LotFinding[];
  healthy: boolean;
};

// Se pagina de a tandas en vez de traer todos los lotes: contra una copia de
// producción la tabla puede ser grande, y este proceso tiene que poder correr
// sin comerse la memoria ni sostener una consulta enorme (presupuesto D3).
const DEFAULT_BATCH_SIZE = 500;

export async function reconcileInventory(
  params: { productId?: string; batchSize?: number } = {},
  client: Prisma.TransactionClient = prisma,
): Promise<ReconciliationReport> {
  const batchSize = params.batchSize ?? DEFAULT_BATCH_SIZE;
  const where = params.productId ? { productId: params.productId } : {};

  const findings: LotFinding[] = [];
  let checkedLots = 0;
  let cursor: string | null = null;

  for (;;) {
    // Anotado a mano: el cursor sale de la tanda y la tanda depende del cursor,
    // así que sin el tipo explícito la inferencia se muerde la cola.
    const lots: LotRow[] = await client.lot.findMany({
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      where,
      orderBy: { id: "asc" },
      select: { id: true, productId: true, lotNumber: true, onHand: true },
    });
    if (lots.length === 0) break;

    for (const lot of lots) {
      checkedLots += 1;
      const finding = await inspectLot(lot, client);
      if (finding) findings.push(finding);
    }

    if (lots.length < batchSize) break;
    cursor = lots.at(-1)!.id;
  }

  return { checkedLots, findings, healthy: findings.length === 0 };
}

type LotRow = {
  id: string;
  productId: string;
  lotNumber: string;
  onHand: number;
};

async function inspectLot(
  lot: LotRow,
  client: Prisma.TransactionClient,
): Promise<LotFinding | null> {
  const ledgerOnHand = await computeLedgerOnHand(lot.id, client);
  const activeReserved = await computeActiveReserved(lot.id, client);
  const available = computeAvailable(lot.onHand, activeReserved);

  const issues: ReconciliationIssue[] = [];
  if (lot.onHand !== ledgerOnHand) issues.push("COLUMN_DRIFT");
  if (available < 0) issues.push("OVERCOMMITTED");
  if (activeReserved < 0) issues.push("NEGATIVE_RESERVED");

  if (issues.length === 0) return null;

  return {
    lotId: lot.id,
    productId: lot.productId,
    lotNumber: lot.lotNumber,
    onHand: lot.onHand,
    ledgerOnHand,
    activeReserved,
    available,
    issues,
  };
}

/** Resumen legible para el operador que corre el comando. */
export function formatReconciliationReport(report: ReconciliationReport): string {
  if (report.healthy) {
    return `Inventario consistente: ${report.checkedLots} lote(s) revisado(s), sin hallazgos.`;
  }

  const lines = report.findings.map((finding) => {
    const detail = `columna ${finding.onHand} · ledger ${finding.ledgerOnHand} · comprometido ${finding.activeReserved} · disponible ${finding.available}`;
    return `  [${finding.issues.join(", ")}] lote ${finding.lotNumber} (${finding.lotId}) — ${detail}`;
  });

  return [
    `Inventario CON HALLAZGOS: ${report.findings.length} de ${report.checkedLots} lote(s) revisado(s).`,
    ...lines,
  ].join("\n");
}
