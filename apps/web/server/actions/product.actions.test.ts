import { beforeEach, describe, expect, it, vi } from "vitest";

// Aislamos la action: el foco es el guard. `requireCapability` es
// DB-authoritative (relee rol/estado de la base), así que un JWT viejo de un
// usuario degradado/desactivado se traduce en un redirect que corta el flujo
// ANTES de cualquier mutación. Mockeamos cada borde.
const {
  requireCapability,
  addProduct,
  recordAudit,
  auditContextFromHeaders,
  revalidatePath,
  safeParse,
} = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  addProduct: vi.fn(),
  recordAudit: vi.fn(),
  auditContextFromHeaders: vi.fn(),
  revalidatePath: vi.fn(),
  safeParse: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/auth/require-role", () => ({ requireCapability }));
vi.mock("@/lib/generated/prisma/client", () => ({
  Prisma: { PrismaClientKnownRequestError: class {} },
}));
vi.mock("@/server/services/product.service", () => ({ addProduct }));
vi.mock("@/server/services/audit.service", () => ({
  recordAudit,
  auditContextFromHeaders,
}));
vi.mock("@/features/productos/schema", () => ({
  productCreateSchema: { safeParse },
}));

import { createProductAction } from "./product.actions";

const PREV = { error: null, ok: false };
const session = { user: { id: "u1", email: "a@x.com", name: "A", role: "ADMIN" } };

beforeEach(() => {
  vi.clearAllMocks();
  auditContextFromHeaders.mockResolvedValue({});
});

describe("createProductAction · guard DB-authoritative", () => {
  it("usa requireCapability('canManageProducts'), no el rol del JWT", async () => {
    requireCapability.mockResolvedValue(session);
    safeParse.mockReturnValue({
      success: true,
      data: { code: "P1", name: "Prod", unit: "u", minStock: 0, reorderQty: 0 },
    });
    addProduct.mockResolvedValue({ id: "p1" });

    await createProductAction(PREV, new FormData());

    expect(requireCapability).toHaveBeenCalledWith("canManageProducts");
  });

  it("pasa laboratoryId al servicio cuando se provee", async () => {
    requireCapability.mockResolvedValue(session);
    safeParse.mockReturnValue({
      success: true,
      data: { code: "P2", name: "Prod2", unit: "u", minStock: 0, reorderQty: 0, laboratoryId: "lab-1" },
    });
    addProduct.mockResolvedValue({ id: "p2" });

    const fd = new FormData();
    fd.set("laboratoryId", "lab-1");
    await createProductAction(PREV, fd);

    expect(addProduct).toHaveBeenCalledWith(
      expect.objectContaining({ laboratoryId: "lab-1" }),
    );
  });

  it("un usuario degradado/desactivado (guard redirige) NO llega a mutar", async () => {
    // requireCapability detecta el estado real en la base y corta con redirect
    // (que en Next lanza). El JWT stale no alcanza para crear productos.
    requireCapability.mockRejectedValue(new Error("REDIRECT:/login"));

    await expect(
      createProductAction(PREV, new FormData()),
    ).rejects.toThrow("REDIRECT:/login");

    expect(safeParse).not.toHaveBeenCalled();
    expect(addProduct).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
