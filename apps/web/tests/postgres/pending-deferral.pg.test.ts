import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { prisma } from "@/lib/db/prisma";
import {
  PendingIdempotencyPayloadConflictError,
  registerPending,
} from "@/server/services/pending.service";

let actorId = "";
let productId = "";
let sequence = 0;

beforeAll(async () => {
  const actor = await prisma.user.create({ data: { email: `deferral-${Date.now()}@test.local`, name: "Deferral actor" } });
  const product = await prisma.product.create({ data: { code: `DEF-${Date.now()}`, name: "Deferred product", unit: "unidad" } });
  actorId = actor.id;
  productId = product.id;
});

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { action: AUDIT_ACTIONS.PENDING_IDENTITY_DEFERRED } });
  await prisma.missingItem.deleteMany({ where: { productId } });
  await prisma.pending.deleteMany({ where: { productId } });
});

function deferred(key = randomUUID(), note: string | undefined = "  Orion offline  ") {
  sequence += 1;
  return {
    productId, createdById: actorId, quantity: sequence, idempotencyKey: key,
    promisedAt: new Date("2030-01-01T00:00:00.000Z"),
    identitySkippedReason: "ORION_UNAVAILABLE" as const, identitySkippedNote: note,
  };
}

describe("registerPending identity deferral", () => {
  it("persists permanent deferral history and a minimal transactional audit without changing Orion identity", async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    const result = await registerPending(deferred());
    const pending = await prisma.pending.findUniqueOrThrow({ where: { id: result.pending.id } });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: AUDIT_ACTIONS.PENDING_IDENTITY_DEFERRED, entityId: pending.id } });

    expect(pending).toMatchObject({ identitySkippedReason: "ORION_UNAVAILABLE", identitySkippedNote: "  Orion offline  " });
    expect(audit).toMatchObject({ action: AUDIT_ACTIONS.PENDING_IDENTITY_DEFERRED, module: AUDIT_MODULES.PENDIENTES, entity: "Pending", entityId: pending.id, userId: actorId, after: { productId, reason: "ORION_UNAVAILABLE" } });
    expect(audit.createdAt).toBeInstanceOf(Date);
    expect(audit.after).not.toHaveProperty("note");
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ orionCode: before.orionCode, identityVersion: before.identityVersion });
  });

  it("rolls back pending and related writes when the deferral audit fails", async () => {
    const manualName = `Failed manual ${Date.now()}`;
    const input = { ...deferred(), productId: undefined, manual: { name: manualName, unit: "unidad" } };
    await expect(registerPending(input, { writeAudit: async () => { throw new Error("audit unavailable"); } })).rejects.toThrow("audit unavailable");

    expect(await prisma.pending.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(0);
    expect(await prisma.missingItem.count({ where: { productId } })).toBe(0);
    expect(await prisma.product.count({ where: { name: manualName } })).toBe(0);
  });

  it("is idempotent for an exact deferral retry but rejects normalized deferral changes", async () => {
    const input = deferred();
    const first = await registerPending(input);
    const replay = await registerPending({ ...input, identitySkippedNote: "Orion offline" });

    expect(replay).toMatchObject({ replayed: true, pending: { id: first.pending.id } });
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.PENDING_IDENTITY_DEFERRED, entityId: first.pending.id } })).toBe(1);
    await expect(registerPending({ ...input, identitySkippedReason: "CODE_NOT_FOUND" })).rejects.toBeInstanceOf(PendingIdempotencyPayloadConflictError);
    await expect(registerPending({ ...input, identitySkippedNote: "different note" })).rejects.toBeInstanceOf(PendingIdempotencyPayloadConflictError);
  });

  it("keeps ordinary registrations legacy-compatible and rejects a note without a reason", async () => {
    const ordinary = await registerPending({ ...deferred(), identitySkippedReason: undefined, identitySkippedNote: undefined });
    const withoutNote = await registerPending({ ...deferred(), identitySkippedNote: undefined });
    await expect(registerPending({ ...deferred(), identitySkippedReason: undefined, identitySkippedNote: "orphan note" })).rejects.toThrow("identitySkippedNote requires identitySkippedReason");

    expect(ordinary.pending).toMatchObject({ identitySkippedReason: null, identitySkippedNote: null });
    expect(withoutNote.pending).toMatchObject({ identitySkippedReason: "ORION_UNAVAILABLE", identitySkippedNote: null });
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.PENDING_IDENTITY_DEFERRED, entityId: ordinary.pending.id } })).toBe(0);
  });
});
