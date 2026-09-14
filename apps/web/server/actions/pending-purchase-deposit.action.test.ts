import { beforeEach, describe, expect, it, vi } from "vitest";

// --------------------------------------------------------------------------
// Depósito de compra: la Server Action con el service y el repositorio REALES.
//
// Solo se reemplazan los bordes que no existen en un test: la sesión, la base
// (una transacción falsa que registra lo que se escribe) y Next. Así la prueba
// cubre la cadena entera —permiso, validación, estado del pendiente, escritura
// y auditoría— y no un doble que diga que sí a todo.
// --------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    pending: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    prisma: { $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)) },
    requireCapability: vi.fn(),
    checkCapability: vi.fn(),
    revalidatePath: vi.fn(),
    recordAudit: vi.fn(),
    auditContextFromHeaders: vi.fn(),
  };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
  checkCapability: mocks.checkCapability,
}));
vi.mock("@/server/services/audit.service", () => ({
  recordAudit: mocks.recordAudit,
  auditContextFromHeaders: mocks.auditContextFromHeaders,
}));

import { can, type Capability } from "@/lib/auth/permissions";
import type { SessionRole } from "@/lib/auth/session";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { updatePendingPurchaseDepositAction } from "./pending.actions";

const PREV = { error: null, ok: false };

// El guard real redirige cuando falta la capacidad; acá se simula con la MATRIZ
// real, así que la prueba cae si alguien cambia quién tiene el permiso.
function actAs(role: SessionRole) {
  mocks.requireCapability.mockImplementation(async (capability: Capability) => {
    if (!can(role, capability)) throw new Error("REDIRECT:/dashboard");
    return { user: { id: `user-${role}`, role } };
  });
}

function depositForm(deposit: string) {
  const data = new FormData();
  data.set("id", "pend-1");
  data.set("deposit", deposit);
  return data;
}

function currentIs(status: string, purchaseDeposit: string | null) {
  mocks.tx.$queryRaw.mockResolvedValue([{ id: "pend-1", status, purchaseDeposit }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tx.pending.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.auditLog.create.mockResolvedValue({});
  mocks.auditContextFromHeaders.mockImplementation(async (userId: string) => ({
    userId,
    ip: "10.0.0.1",
    userAgent: "vitest",
    channel: "web",
  }));
  currentIs("PENDIENTE", null);
});

describe("updatePendingPurchaseDepositAction · permiso", () => {
  it.each(["OPERADOR", "SUPERVISOR"] as const)(
    "%s no puede escribirlo: corta antes de tocar la base",
    async (role) => {
      actAs(role);

      await expect(
        updatePendingPurchaseDepositAction(PREV, depositForm("N3")),
      ).rejects.toThrow("REDIRECT:/dashboard");

      expect(mocks.requireCapability).toHaveBeenCalledWith("canManagePurchaseDeposit");
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
      expect(mocks.tx.pending.updateMany).not.toHaveBeenCalled();
      expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it.each(["SUPERADMIN", "ADMIN", "BODEGA"] as const)(
    "%s lo guarda en cualquier pendiente abierto, no solo en los suyos",
    async (role) => {
      actAs(role);

      const result = await updatePendingPurchaseDepositAction(PREV, depositForm("N3"));

      expect(result).toEqual({ error: null, ok: true });
      const args = mocks.tx.pending.updateMany.mock.calls[0]![0];
      expect(args.where).not.toHaveProperty("createdById");
      expect(args.data).toEqual({ purchaseDeposit: "N3" });
    },
  );
});

describe("updatePendingPurchaseDepositAction · validación", () => {
  beforeEach(() => actAs("BODEGA"));

  it("guarda el texto sin los espacios de los bordes", async () => {
    const result = await updatePendingPurchaseDepositAction(PREV, depositForm("  Depósito 2  "));

    expect(result).toEqual({ error: null, ok: true });
    expect(mocks.tx.pending.updateMany).toHaveBeenCalledWith({
      where: { id: "pend-1", status: { notIn: ["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"] } },
      data: { purchaseDeposit: "Depósito 2" },
    });
    // Se lee con la fila bloqueada: el "antes" auditado es el que se reemplaza.
    const lockSql = (mocks.tx.$queryRaw.mock.calls[0]![0] as readonly string[]).join("?");
    expect(lockSql).toContain("FOR UPDATE");
  });

  it("vacío o solo espacios guarda null", async () => {
    currentIs("PENDIENTE", "N1");

    const result = await updatePendingPurchaseDepositAction(PREV, depositForm("   "));

    expect(result).toEqual({ error: null, ok: true });
    expect(mocks.tx.pending.updateMany.mock.calls[0]![0].data).toEqual({ purchaseDeposit: null });
  });

  it("acepta exactamente 80 caracteres y rechaza 81 sin tocar la base", async () => {
    const atLimit = await updatePendingPurchaseDepositAction(PREV, depositForm("a".repeat(80)));
    expect(atLimit.ok).toBe(true);

    vi.clearAllMocks();
    actAs("BODEGA");
    const tooLong = await updatePendingPurchaseDepositAction(PREV, depositForm("a".repeat(81)));

    expect(tooLong.ok).toBe(false);
    expect(tooLong.error).toBeTruthy();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rechaza un formulario sin id", async () => {
    const data = new FormData();
    data.set("deposit", "N3");

    const result = await updatePendingPurchaseDepositAction(PREV, data);

    expect(result.ok).toBe(false);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("updatePendingPurchaseDepositAction · estado del pendiente", () => {
  beforeEach(() => actAs("ADMIN"));

  it.each(["ENTREGADO", "CANCELADO", "CLOSED_PARTIAL"])(
    "un pendiente %s ya no se edita: no escribe ni audita",
    async (status) => {
      currentIs(status, "N1");

      const result = await updatePendingPurchaseDepositAction(PREV, depositForm("N3"));

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      expect(mocks.tx.pending.updateMany).not.toHaveBeenCalled();
      expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("si se cerró entre la lectura y la escritura, tampoco audita", async () => {
    mocks.tx.pending.updateMany.mockResolvedValue({ count: 0 });

    const result = await updatePendingPurchaseDepositAction(PREV, depositForm("N3"));

    expect(result.ok).toBe(false);
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("un pendiente que no existe se rechaza", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([]);

    const result = await updatePendingPurchaseDepositAction(PREV, depositForm("N3"));

    expect(result.ok).toBe(false);
    expect(mocks.tx.pending.updateMany).not.toHaveBeenCalled();
  });
});

describe("updatePendingPurchaseDepositAction · auditoría", () => {
  beforeEach(() => actAs("BODEGA"));

  it("registra el antes y el después, con quién y desde dónde", async () => {
    currentIs("SOLICITADO", "N1");

    await updatePendingPurchaseDepositAction(PREV, depositForm("Depósito 2"));

    expect(mocks.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.auditLog.create.mock.calls[0]![0].data).toEqual(
      expect.objectContaining({
        action: AUDIT_ACTIONS.PENDING_PURCHASE_DEPOSIT_UPDATED,
        module: AUDIT_MODULES.PENDIENTES,
        entity: "Pending",
        entityId: "pend-1",
        result: "SUCCESS",
        before: { purchaseDeposit: "N1" },
        after: { purchaseDeposit: "Depósito 2" },
        userId: "user-BODEGA",
        ip: "10.0.0.1",
      }),
    );
    expect(AUDIT_ACTIONS.PENDING_PURCHASE_DEPOSIT_UPDATED).toBe("pending.purchase_deposit.updated");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/revision-pendientes");
  });

  it("guardar el mismo valor no escribe ni audita", async () => {
    currentIs("PENDIENTE", "N3");

    const result = await updatePendingPurchaseDepositAction(PREV, depositForm(" N3 "));

    expect(result).toEqual({ error: null, ok: true });
    expect(mocks.tx.pending.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });
});
