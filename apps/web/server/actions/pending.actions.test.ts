import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditContextFromHeaders: vi.fn(),
  cancelPendingCommitment: vi.fn(),
  contactPending: vi.fn(),
  deliverPending: vi.fn(),
  invoicePending: vi.fn(),
  recordAudit: vi.fn(),
  registerPending: vi.fn(),
  setPendingManagementStatus: vi.fn(),
  requireCapability: vi.fn(),
  checkCapability: vi.fn(),
  revalidatePath: vi.fn(),
  PendingIdempotencyPayloadConflictError: class PendingIdempotencyPayloadConflictError extends Error {
    constructor() {
      super("idempotency key was already used for a different pending payload");
    }
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/require-role", () => ({
  requireCapability: mocks.requireCapability,
  checkCapability: mocks.checkCapability,
}));
vi.mock("@/server/services/audit.service", () => ({
  auditContextFromHeaders: mocks.auditContextFromHeaders,
  recordAudit: mocks.recordAudit,
}));
vi.mock("@/server/services/pending.service", () => ({
  cancelPendingCommitment: mocks.cancelPendingCommitment,
  contactPending: mocks.contactPending,
  deliverPending: mocks.deliverPending,
  invoicePending: mocks.invoicePending,
  PendingIdempotencyPayloadConflictError: mocks.PendingIdempotencyPayloadConflictError,
  registerPending: mocks.registerPending,
  setPendingManagementStatus: mocks.setPendingManagementStatus,
}));

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import {
  cancelPendingAction,
  contactPendingAction,
  createPendingAction,
  deliverPendingAction,
  invoicePendingAction,
  updatePendingManagementStatusAction,
} from "./pending.actions";

const PREV = { error: null, ok: false };
// UUID de prueba deliberadamente reconocible: un valor de aspecto aleatorio
// hace dudar al lector si es un dato real, y además el escaneo de secretos lo
// marca como posible credencial filtrada.
const ATTEMPT_UUID = "00000000-0000-4000-8000-000000000001";

function deliverFormData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("id", "pend-1");
  data.set("quantity", "3");
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

function cancelFormData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("id", "pend-1");
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.revalidatePath.mockReset();
  mocks.recordAudit.mockResolvedValue({ ok: true });
  mocks.auditContextFromHeaders.mockResolvedValue({ userId: "user-1", channel: "web" });
});

// El formulario tiene dos modos EXCLUYENTES y cada uno postea campos distintos:
// catálogo envía `productId`, manual envía `manualName` y NO envía `productId`.
// Estos tests arman el FormData real de cada modo (no un objeto plano), porque
// la regresión que cubren vivía justo en esa frontera: `FormData.get` devuelve
// null para un campo ausente y el schema solo acepta undefined.
function createCatalogFormData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("productId", "prod-1");
  data.set("quantity", "2");
  data.set("promisedAt", "2099-01-02T12:00");
  data.set("customerName", "Ana Pérez");
  data.set("customerPhone", "3001234567");
  data.set("idempotencyKey", ATTEMPT_UUID);
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

function createManualFormData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("manualName", "Ibuprofeno jarabe");
  data.set("manualUnit", "frasco");
  data.set("quantity", "2");
  data.set("promisedAt", "2099-01-02T12:00");
  data.set("customerName", "Ana Pérez");
  data.set("customerPhone", "3001234567");
  data.set("idempotencyKey", ATTEMPT_UUID);
  // Desde S2b un producto manual llega SIEMPRE con identidad resuelta: no
  // existe todavía en el catálogo, así que no puede tener código de antes.
  data.set("orionCode", "ORN-2002");
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

// El éxito ya no es solo `{error:null, ok:true}`: lleva un `submissionId` que
// cambia en cada respuesta y que el formulario usa como clave de remonte. Se
// comprueba su presencia, no su valor —es aleatorio por diseño.
function expectSuccess(result: { error: string | null; ok: boolean; submissionId?: string; values?: unknown }) {
  expect(result.ok).toBe(true);
  expect(result.error).toBeNull();
  expect(typeof result.submissionId).toBe("string");
  // En éxito NO viaja el eco: su ausencia es lo que vacía el formulario.
  expect(result.values ?? null).toBeNull();
}

describe("createPendingAction", () => {
  beforeEach(() => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });
    mocks.checkCapability.mockResolvedValue({
      ok: true,
      session: { user: { id: "op-1", role: "OPERADOR", email: "op1@drogueria.test" } },
    });
    mocks.registerPending.mockResolvedValue({
      pending: { id: "pend-1", productId: "prod-1" },
      missingItem: null,
      createdProduct: null,
      replayed: false,
    });
  });

  it("registra un pendiente del catálogo", async () => {
    const result = await createPendingAction(PREV, createCatalogFormData());

    expectSuccess(result);
    expect(mocks.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "prod-1", quantity: 2, createdById: "op-1" }),
    );
  });

  it("registra un pendiente manual aunque el form no postee productId", async () => {
    mocks.registerPending.mockResolvedValue({
      pending: { id: "pend-2", productId: "prod-nuevo" },
      missingItem: null,
      createdProduct: { id: "prod-nuevo", code: "MAN-ABC", name: "Ibuprofeno jarabe", unit: "frasco" },
      replayed: false,
    });

    const result = await createPendingAction(PREV, createManualFormData());

    expectSuccess(result);
    expect(mocks.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: undefined,
        manual: { name: "Ibuprofeno jarabe", unit: "frasco" },
      }),
    );
  });

  it("lleva zona canonizada y montos en pesos enteros hasta el service", async () => {
    await createPendingAction(
      PREV,
      createCatalogFormData({
        zone: "  NORTE ",
        totalAmount: "$ 45.000",
        paidAmount: "20.000",
      }),
    );

    expect(mocks.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({ zone: "Norte", totalAmount: 45_000, paidAmount: 20_000 }),
    );
  });

  it("audita el dinero comprometido con el cliente", async () => {
    await createPendingAction(
      PREV,
      createCatalogFormData({ totalAmount: "45.000", paidAmount: "45.000" }),
    );

    const auditCall = mocks.recordAudit.mock.calls.find(
      (call) => call[0].action === AUDIT_ACTIONS.PENDING_CREATE,
    )![0];
    expect(auditCall.after).toEqual(
      expect.objectContaining({ totalAmount: 45_000, paidAmount: 45_000 }),
    );
  });

  it("returns success when revalidation fails after persistence", async () => {
    mocks.revalidatePath.mockImplementation(() => {
      throw new Error("cache unavailable");
    });

    expectSuccess(await createPendingAction(PREV, createCatalogFormData()));
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
  });

  it("returns a terminal visible error when persistence rejects", async () => {
    mocks.registerPending.mockRejectedValue(new Error("database unavailable"));

    const result = await createPendingAction(PREV, createCatalogFormData());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(
      /^No se pudo registrar el pendiente\. Volvé a intentar en unos segundos\. Código: PND-[2-9A-HJ-NP-TV-Z]{6}$/,
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns success when audit context fails after persistence", async () => {
    mocks.auditContextFromHeaders.mockRejectedValue(new Error("headers unavailable"));

    expectSuccess(await createPendingAction(PREV, createCatalogFormData()));
    expect(mocks.registerPending).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/faltantes");
  });

  it("rechaza cuando no llega ni producto del catálogo ni manual", async () => {
    const data = new FormData();
    data.set("quantity", "2");
    data.set("promisedAt", "2099-01-02T12:00");

    const result = await createPendingAction(PREV, data);

    expect(result.ok).toBe(false);
    expect(mocks.registerPending).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------------
  // CAUSA RAÍZ del incidente de agosto de 2026 (log del VPS, 20:50–20:55):
  //
  //   Code: 23514 — new row for relation "pendings" violates check constraint
  //   "pendings_total_amount_positive"
  //
  // La base exige `"totalAmount" IS NULL OR > 0`; el validador aceptaba cero.
  // Un "0" en el valor total pasaba Zod, moría en el INSERT y devolvía un error
  // genérico que invitaba a reintentar algo que nunca iba a entrar.
  // ------------------------------------------------------------------------

  // En el mostrador, "0" es como se escribe "no sé cuánto sale". El pendiente
  // TIENE que entrar: frenar a alguien con un cliente enfrente por una convención
  // de captura es exactamente el problema que este PR viene a resolver.
  it("registra el pendiente cuando el valor total va en cero, guardándolo como desconocido", async () => {
    const result = await createPendingAction(PREV, createCatalogFormData({ totalAmount: "0" }));

    expectSuccess(result);
    // Traducido a NULL: nunca llega el cero que la base rechaza.
    expect(mocks.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({ totalAmount: undefined }),
    );
    // Escribió una cosa y se guardó otra: hay que avisarle.
    expect(result.savedWithoutTotalAmount).toBe(true);
  });

  // Dejar el campo vacío es una decisión consciente, no una reinterpretación:
  // avisar ahí sería ruido sobre algo que la persona ya sabe.
  it("no avisa nada cuando el valor total se dejó vacío a propósito", async () => {
    const result = await createPendingAction(PREV, createCatalogFormData({ totalAmount: "" }));

    expectSuccess(result);
    expect(result.savedWithoutTotalAmount).toBe(false);
  });

  it("no avisa nada cuando el valor total sí se cargó", async () => {
    const result = await createPendingAction(PREV, createCatalogFormData({ totalAmount: "45.000" }));

    expectSuccess(result);
    expect(result.savedWithoutTotalAmount).toBe(false);
  });

  // Todas estas formas se compactan a "0" y llegaban igual a la base.
  it.each(["0", "$ 0", "$0", "0.00", "000"])(
    "trata el valor total escrito como %s igual que un campo vacío",
    async (totalAmount) => {
      expectSuccess(await createPendingAction(PREV, createCatalogFormData({ totalAmount })));
      expect(mocks.registerPending).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: undefined }),
      );
    },
  );

  it("sigue aceptando un valor total ausente: no saber el precio es válido", async () => {
    expectSuccess(await createPendingAction(PREV, createCatalogFormData({ totalAmount: "" })));
    expect(mocks.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({ totalAmount: undefined }),
    );
  });

  // Un negativo no es "no sé", es imposible. Ahí sí se frena.
  it("rechaza un valor total negativo sin tocar la base", async () => {
    const result = await createPendingAction(PREV, createCatalogFormData({ totalAmount: "-500" }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no puede ser negativo");
    expect(mocks.registerPending).not.toHaveBeenCalled();
  });

  // Con el total desconocido, un abono cualquiera es legítimo: no hay techo con
  // el cual compararlo. Antes esto chocaba contra "el abono supera el total".
  it("permite registrar un abono aunque el valor total sea desconocido", async () => {
    expectSuccess(
      await createPendingAction(PREV, createCatalogFormData({ totalAmount: "0", paidAmount: "20.000" })),
    );
    expect(mocks.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({ totalAmount: undefined, paidAmount: 20_000 }),
    );
  });

  // El abono SÍ puede ser cero: es la verdad de quien no dejó plata. La base lo
  // permite (`pendings_paid_amount_nonneg` es >= 0) y el formulario también.
  it("acepta un abono en cero, que es un dato legítimo", async () => {
    expectSuccess(
      await createPendingAction(PREV, createCatalogFormData({ totalAmount: "45.000", paidAmount: "0" })),
    );
    expect(mocks.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({ totalAmount: 45_000, paidAmount: 0 }),
    );
  });

  // Red de seguridad: si alguna otra restricción CHECK se viola en el futuro, el
  // mensaje no puede volver a decir "intentá de nuevo" sobre un fallo que se
  // repite siempre igual.
  it("no invita a reintentar cuando la base rechaza por integridad", async () => {
    const violation = Object.assign(
      new Error('violates check constraint "pendings_quantities_check"'),
      { code: "P2039", meta: { modelName: "Pending" } },
    );
    mocks.registerPending.mockRejectedValue(violation);

    const result = await createPendingAction(PREV, createCatalogFormData());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reintentar sin corregirlos va a fallar igual/);
    expect(result.error).not.toMatch(/intentá de nuevo|volvé a intentar/i);
    expect(result.values).toEqual(expect.objectContaining({ customerName: "Ana Pérez" }));
  });

  it("sí invita a reintentar cuando el fallo es transitorio", async () => {
    mocks.registerPending.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const result = await createPendingAction(PREV, createCatalogFormData());

    expect(result.error).toMatch(/Volvé a intentar en unos segundos/);
  });

  // ------------------------------------------------------------------------
  // Regresión del incidente: lo que se le devuelve al formulario tras un fallo.
  // Sin el eco, React limpia los campos y hay que tipear todo otra vez.
  // ------------------------------------------------------------------------

  const FALLOS = [
    [
      "excepción de persistencia",
      () => mocks.registerPending.mockRejectedValue(new Error("database unavailable")),
    ],
    [
      "sesión vencida",
      () => mocks.checkCapability.mockResolvedValue({ ok: false, reason: "NO_SESSION" }),
    ],
    [
      "usuario sin permiso",
      () => mocks.checkCapability.mockResolvedValue({ ok: false, reason: "FORBIDDEN" }),
    ],
  ] as const;

  it.each(FALLOS)("devuelve el eco de lo cargado ante %s", async (_label, arrange) => {
    arrange();

    const result = await createPendingAction(
      PREV,
      createCatalogFormData({ note: "Va con pedido", zone: "El Poblado" }),
    );

    expect(result.ok).toBe(false);
    // Los valores vuelven EXACTOS: es lo que permite reintentar sin reescribir.
    expect(result.values).toEqual(
      expect.objectContaining({
        productId: "prod-1",
        quantity: "2",
        customerName: "Ana Pérez",
        customerPhone: "3001234567",
        note: "Va con pedido",
        zone: "El Poblado",
      }),
    );
    // Y un código dictable para encontrar ESE intento en el log del servidor.
    expect(result.supportCode).toMatch(/^PND-[2-9A-HJ-NP-TV-Z]{6}$/);
    expect(result.error).toContain(result.supportCode!);
  });

  it("una sesión vencida no redirige: eso perdería lo cargado", async () => {
    mocks.checkCapability.mockResolvedValue({ ok: false, reason: "NO_SESSION" });

    const result = await createPendingAction(PREV, createCatalogFormData());

    expect(result.error).toMatch(/sesión venció/i);
    expect(mocks.registerPending).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------------
  // Idempotencia: reintentar no puede crear un segundo pendiente.
  // ------------------------------------------------------------------------

  it("propaga la clave de idempotencia del intento al service", async () => {
    // Distinta del fixture por defecto, para probar que se propaga LA QUE LLEGA
    // y no una cualquiera. Sintética a propósito: ver `ATTEMPT_UUID`.
    const otroIntento = "00000000-0000-4000-8000-000000000002";

    await createPendingAction(PREV, createCatalogFormData({ idempotencyKey: otroIntento }));

    expect(mocks.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: otroIntento }),
    );
  });

  it.each(["", "../../admin"])("rechaza una clave de idempotencia ausente o inválida antes de escribir: %s", async (idempotencyKey) => {
    const result = await createPendingAction(
      PREV,
      createCatalogFormData({ idempotencyKey }),
    );

    expect(result.ok).toBe(false);
    expect(result.values).toEqual(expect.objectContaining({ idempotencyKey }));
    expect(result.error).toMatch(/intento de registro venció/i);
    expect(mocks.registerPending).not.toHaveBeenCalled();
  });

  // Un replay es un ÉXITO: el pendiente existe. Y no se vuelve a auditar, porque
  // el alta ocurrió una sola vez y auditarla dos veces inventaría un hecho.
  it("un reintento que reencuentra su pendiente responde éxito y no audita de nuevo", async () => {
    mocks.registerPending.mockResolvedValue({
      pending: { id: "pend-1", productId: "prod-1" },
      missingItem: null,
      createdProduct: null,
      replayed: true,
    });

    expectSuccess(await createPendingAction(PREV, createCatalogFormData()));
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("marca audit_failed sin convertir una creación confirmada en error", async () => {
    mocks.recordAudit.mockResolvedValue({ ok: false, errorClass: "PrismaError", errorCode: "P2021" });

    expectSuccess(await createPendingAction(PREV, createCatalogFormData()));
  });

  it("rechaza explícitamente la reutilización de clave con payload distinto", async () => {
    mocks.registerPending.mockRejectedValue(
      new mocks.PendingIdempotencyPayloadConflictError(),
    );

    const result = await createPendingAction(PREV, createCatalogFormData());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/datos distintos/i);
    expect(result.values).toEqual(expect.objectContaining({ customerName: "Ana Pérez" }));
  });
});

// --------------------------------------------------------------------------
// La corrección tiene que valer para TODOS los usuarios autorizados. Un arreglo
// que dependa de un correo concreto no es un arreglo, es un parche que deja al
// resto roto — y que nadie recuerda por qué existe seis meses después.
// --------------------------------------------------------------------------
describe("createPendingAction · sin excepciones por usuario", () => {
  const USUARIOS = [
    ["gerente reportante", "u-daniel", "daniel@drogueriaespecifica.com", "ADMIN"],
    ["otro usuario del mismo rol", "u-otro", "otra.persona@drogueriaespecifica.com", "ADMIN"],
    ["usuario de otro rol autorizado", "u-op", "vendedor@drogueriaespecifica.com", "OPERADOR"],
  ] as const;

  it.each(USUARIOS)(
    "%s recorre exactamente el mismo camino de negocio",
    async (_label, id, email, role) => {
      vi.clearAllMocks();
      mocks.auditContextFromHeaders.mockResolvedValue({ userId: id, channel: "web" });
      mocks.checkCapability.mockResolvedValue({ ok: true, session: { user: { id, email, role } } });
      mocks.registerPending.mockResolvedValue({
        pending: { id: "pend-x", productId: "prod-1" },
        missingItem: null,
        createdProduct: null,
        replayed: false,
      });

      const result = await createPendingAction(PREV, createCatalogFormData());

      expect(result.ok).toBe(true);
      expect(mocks.registerPending).toHaveBeenCalledWith(
        expect.objectContaining({ productId: "prod-1", quantity: 2, createdById: id }),
      );
      expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
      expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
    },
  );

  it.each(USUARIOS)("%s recibe el mismo trato ante un fallo", async (_label, id, email, role) => {
    vi.clearAllMocks();
    mocks.checkCapability.mockResolvedValue({ ok: true, session: { user: { id, email, role } } });
    mocks.registerPending.mockRejectedValue(new Error("database unavailable"));

    const result = await createPendingAction(PREV, createCatalogFormData());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^No se pudo registrar el pendiente\./);
    expect(result.error).toMatch(/Código: PND-[2-9A-HJ-NP-TV-Z]{6}$/);
    expect(result.values).toEqual(expect.objectContaining({ customerName: "Ana Pérez" }));
  });
});

describe("deliverPendingAction", () => {
  it("guards with canDeliverPendings and rejects before mutation", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new Error("REDIRECT:/dashboard"));

    await expect(deliverPendingAction(PREV, deliverFormData())).rejects.toThrow(
      "REDIRECT:/dashboard",
    );
    expect(mocks.requireCapability).toHaveBeenCalledWith("canDeliverPendings");
    expect(mocks.deliverPending).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("allows OPERADOR through the capability boundary", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });
    mocks.deliverPending.mockResolvedValue({
      rejection: null,
      pending: { id: "pend-1", status: "PARCIAL", deliveredQuantity: 3, completedAt: null },
    });

    const result = await deliverPendingAction(PREV, deliverFormData());

    expect(result).toEqual({ error: null, ok: true });
    expect(mocks.requireCapability).toHaveBeenCalledWith("canDeliverPendings");
    expect(mocks.deliverPending).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pend-1", quantity: 3, deliveredById: "op-1" }),
    );
  });

  it("audits the delivery without leaking customerName and revalidates active views", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "sup-1", role: "SUPERVISOR" } });
    mocks.deliverPending.mockResolvedValue({
      rejection: null,
      pending: { id: "pend-1", status: "ENTREGADO", deliveredQuantity: 10, completedAt: new Date() },
    });

    await deliverPendingAction(PREV, deliverFormData({ quantity: "10" }));

    expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
    const auditCall = mocks.recordAudit.mock.calls[0]![0];
    expect(auditCall).toEqual(
      expect.objectContaining({
        action: AUDIT_ACTIONS.PENDING_DELIVERED,
        module: AUDIT_MODULES.PENDIENTES,
        entityId: "pend-1",
      }),
    );
    expect(JSON.stringify(auditCall.after)).not.toContain("customerName");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

	const deliveryRejectionCases = [
		["ALREADY_DELIVERED", "Este pendiente ya fue entregado."],
		["ALREADY_CANCELLED", "Este pendiente está cancelado."],
		["NON_POSITIVE_QUANTITY", "Ingresá una cantidad válida."],
		["EXCEEDS_REMAINING", "La cantidad supera lo que resta por entregar."],
	] as const;

	// Un rechazo de negocio es un intento real contra una invariante: quién quiso
	// entregar qué sobre un pendiente que no lo admitía. Se audita como FAILURE
	// para que quede la traza forense, sin `customerName`.
	it.each(deliveryRejectionCases)(
		"maps %s to the exact Spanish message, audits it as FAILURE, and revalidates",
		async (rejection, error) => {
			mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });
			mocks.deliverPending.mockResolvedValue({ rejection, pending: null });

			const result = await deliverPendingAction(PREV, deliverFormData());

			expect(result).toEqual({ error, ok: false });

			expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
			const auditCall = mocks.recordAudit.mock.calls[0]![0];
			expect(auditCall).toEqual(
				expect.objectContaining({
					action: AUDIT_ACTIONS.PENDING_DELIVERED,
					module: AUDIT_MODULES.PENDIENTES,
					entity: "Pending",
					entityId: "pend-1",
					result: "FAILURE",
					after: { reason: rejection, attemptedQuantity: 3 },
				}),
			);
			expect(JSON.stringify(auditCall)).not.toContain("customerName");

			expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
			expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
		},
	);

	// BODEGA (T4.4) puede entregar lo suyo, pero el service rechaza un pendiente
	// ajeno con NOT_OWNER; la action mapea el mensaje y audita la denegación.
	it("BODEGA no puede entregar un pendiente ajeno (NOT_OWNER) y lo audita", async () => {
		mocks.requireCapability.mockResolvedValue({ user: { id: "bodega-1", role: "BODEGA" } });
		mocks.deliverPending.mockResolvedValue({ rejection: "NOT_OWNER", pending: null });

		const result = await deliverPendingAction(PREV, deliverFormData());

		expect(result).toEqual({
			error: "No podés operar un pendiente creado por otro vendedor.",
			ok: false,
		});
		expect(mocks.requireCapability).toHaveBeenCalledWith("canDeliverPendings");

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const auditCall = mocks.recordAudit.mock.calls[0]![0];
		expect(auditCall).toEqual(
			expect.objectContaining({
				action: AUDIT_ACTIONS.PENDING_DELIVERED,
				module: AUDIT_MODULES.PENDIENTES,
				entity: "Pending",
				entityId: "pend-1",
				result: "FAILURE",
				after: { reason: "NOT_OWNER", attemptedQuantity: 3 },
			}),
		);
		expect(JSON.stringify(auditCall)).not.toContain("customerName");

		expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
	});

  it("rejects invalid input before calling the service", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "op-1", role: "OPERADOR" } });

    const result = await deliverPendingAction(PREV, deliverFormData({ quantity: "0" }));

    expect(result.ok).toBe(false);
    expect(mocks.deliverPending).not.toHaveBeenCalled();
  });
});

describe("cancelPendingAction", () => {
  it("guards with canCancelPendings and rejects before mutation", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new Error("REDIRECT:/dashboard"));

    await expect(cancelPendingAction(PREV, cancelFormData())).rejects.toThrow(
      "REDIRECT:/dashboard",
    );
    expect(mocks.requireCapability).toHaveBeenCalledWith("canCancelPendings");
    expect(mocks.cancelPendingCommitment).not.toHaveBeenCalled();
  });

  it("rejects OPERADOR via the capability guard (never reaches the service)", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new Error("REDIRECT:/dashboard"));

    await expect(cancelPendingAction(PREV, cancelFormData())).rejects.toThrow();
    expect(mocks.cancelPendingCommitment).not.toHaveBeenCalled();
  });

  it("allows SUPERVISOR to cancel, audits without customerName, and revalidates", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "sup-1", role: "SUPERVISOR" } });
    mocks.cancelPendingCommitment.mockResolvedValue({
      rejection: null,
      pending: { id: "pend-1", status: "CANCELADO", cancelledAt: new Date() },
    });

    const result = await cancelPendingAction(PREV, cancelFormData({ reason: "Cliente desistió" }));

    expect(result).toEqual({ error: null, ok: true });
    expect(mocks.cancelPendingCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pend-1", cancelledById: "sup-1", reason: "Cliente desistió" }),
    );
    const auditCall = mocks.recordAudit.mock.calls[0]![0];
    expect(auditCall).toEqual(
      expect.objectContaining({
        action: AUDIT_ACTIONS.PENDING_CANCELLED,
        module: AUDIT_MODULES.PENDIENTES,
        entityId: "pend-1",
      }),
    );
    expect(JSON.stringify(auditCall.after)).not.toContain("customerName");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

	const cancelRejectionCases = [
		["ALREADY_DELIVERED", "No se puede cancelar un pendiente ya entregado."],
		["ALREADY_CANCELLED", "Este pendiente ya está cancelado."],
	] as const;

	it.each(cancelRejectionCases)(
		"maps %s to the exact Spanish message, audits it as FAILURE, and revalidates",
		async (rejection, error) => {
			mocks.requireCapability.mockResolvedValue({ user: { id: "sup-1", role: "SUPERVISOR" } });
			mocks.cancelPendingCommitment.mockResolvedValue({ rejection, pending: null });

			const result = await cancelPendingAction(PREV, cancelFormData());

			expect(result).toEqual({ error, ok: false });

			expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
			const auditCall = mocks.recordAudit.mock.calls[0]![0];
			expect(auditCall).toEqual(
				expect.objectContaining({
					action: AUDIT_ACTIONS.PENDING_CANCELLED,
					module: AUDIT_MODULES.PENDIENTES,
					entity: "Pending",
					entityId: "pend-1",
					result: "FAILURE",
					after: { reason: rejection },
				}),
			);
			expect(JSON.stringify(auditCall)).not.toContain("customerName");

			expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
			expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
		},
	);

	// BODEGA (T4.4) puede cancelar lo suyo, pero el service rechaza un pendiente
	// ajeno con NOT_OWNER; la action mapea el mensaje y audita la denegación.
	it("BODEGA no puede cancelar un pendiente ajeno (NOT_OWNER) y lo audita", async () => {
		mocks.requireCapability.mockResolvedValue({ user: { id: "bodega-1", role: "BODEGA" } });
		mocks.cancelPendingCommitment.mockResolvedValue({ rejection: "NOT_OWNER", pending: null });

		const result = await cancelPendingAction(PREV, cancelFormData());

		expect(result).toEqual({
			error: "No podés operar un pendiente creado por otro vendedor.",
			ok: false,
		});
		expect(mocks.requireCapability).toHaveBeenCalledWith("canCancelPendings");

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const auditCall = mocks.recordAudit.mock.calls[0]![0];
		expect(auditCall).toEqual(
			expect.objectContaining({
				action: AUDIT_ACTIONS.PENDING_CANCELLED,
				module: AUDIT_MODULES.PENDIENTES,
				entity: "Pending",
				entityId: "pend-1",
				result: "FAILURE",
				after: { reason: "NOT_OWNER" },
			}),
		);
		expect(JSON.stringify(auditCall)).not.toContain("customerName");

		expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
	});

	// El motivo de cancelación es texto libre del operador: puede nombrar al
	// cliente. En un rechazo la cancelación no ocurrió, así que el intento se
	// audita con el código de rechazo y nunca con ese texto.
	it("keeps the operator's free-text cancel reason out of the failure audit", async () => {
		mocks.requireCapability.mockResolvedValue({ user: { id: "sup-1", role: "SUPERVISOR" } });
		mocks.cancelPendingCommitment.mockResolvedValue({
			rejection: "ALREADY_DELIVERED",
			pending: null,
		});

		await cancelPendingAction(
			PREV,
			cancelFormData({ reason: "El cliente Juan Pérez ya lo retiró" }),
		);

		const auditCall = mocks.recordAudit.mock.calls[0]![0];
		expect(JSON.stringify(auditCall)).not.toContain("Juan Pérez");
	});
});

function managementFormData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("id", "pend-1");
  data.set("status", "SOLICITADO");
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

describe("updatePendingManagementStatusAction", () => {
  // Autoridad de compras: gerencia (canOrderMissingItems), NO canCancelPendings.
  it("exige la capacidad de compras y corta si no la tiene", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new Error("REDIRECT:/dashboard"));

    await expect(
      updatePendingManagementStatusAction(PREV, managementFormData()),
    ).rejects.toThrow("REDIRECT:/dashboard");

    expect(mocks.requireCapability).toHaveBeenCalledWith("canOrderMissingItems");
    expect(mocks.setPendingManagementStatus).not.toHaveBeenCalled();
  });

  it("rechaza un status que no es de gestión sin llamar al service", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "adm-1", role: "ADMIN" } });

    const result = await updatePendingManagementStatusAction(
      PREV,
      managementFormData({ status: "ENTREGADO" }),
    );

    expect(result.ok).toBe(false);
    expect(mocks.setPendingManagementStatus).not.toHaveBeenCalled();
  });

  it("fija el estado, audita el cambio y revalida en el camino feliz", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "adm-1", role: "ADMIN" } });
    mocks.setPendingManagementStatus.mockResolvedValue({
      pending: { id: "pend-1", status: "COTIZANDO" },
      rejection: null,
    });

    const result = await updatePendingManagementStatusAction(
      PREV,
      managementFormData({ status: "COTIZANDO" }),
    );

    expect(mocks.setPendingManagementStatus).toHaveBeenCalledWith({
      id: "pend-1",
      status: "COTIZANDO",
      expectedStatus: undefined,
    });
    const auditCall = mocks.recordAudit.mock.calls[0]![0];
    expect(auditCall.action).toBe(AUDIT_ACTIONS.PENDING_STATUS_CHANGE);
    expect(auditCall.module).toBe(AUDIT_MODULES.PENDIENTES);
    expect(auditCall.after).toEqual({ status: "COTIZANDO" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/pendientes");
    // AGOTADO cambia los contadores del dashboard: debe revalidarse también.
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(result).toEqual({ error: null, ok: true });
  });

  it("traduce el rechazo NOT_ELIGIBLE a un mensaje y lo audita como FAILURE", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "adm-1", role: "ADMIN" } });
    mocks.setPendingManagementStatus.mockResolvedValue({
      pending: null,
      rejection: "NOT_ELIGIBLE",
    });

    const result = await updatePendingManagementStatusAction(
      PREV,
      managementFormData({ status: "AGOTADO" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no admite cambios de gestión/i);
    const auditCall = mocks.recordAudit.mock.calls[0]![0];
    expect(auditCall.result).toBe("FAILURE");
    expect(auditCall.after).toEqual({ reason: "NOT_ELIGIBLE", status: "AGOTADO" });
  });

  it("passes the quick action's observed status so a concurrent decision conflicts", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "adm-1", role: "ADMIN" } });
    mocks.setPendingManagementStatus.mockResolvedValue({ pending: null, rejection: "NOT_ELIGIBLE" });

    const result = await updatePendingManagementStatusAction(
      PREV,
      managementFormData({ expectedStatus: "PENDIENTE" }),
    );

    expect(mocks.setPendingManagementStatus).toHaveBeenCalledWith({
      id: "pend-1",
      status: "SOLICITADO",
      expectedStatus: "PENDIENTE",
    });
    expect(result.ok).toBe(false);
  });

  it.each(["audit", "headers", "revalidate"])(
    "returns success after a confirmed management change when %s fails",
    async (failure) => {
      mocks.requireCapability.mockResolvedValue({ user: { id: "adm-1", role: "ADMIN" } });
      mocks.setPendingManagementStatus.mockResolvedValue({
        pending: { id: "pend-1", status: "SOLICITADO" },
        rejection: null,
      });
      if (failure === "audit") mocks.recordAudit.mockRejectedValueOnce(new Error("audit unavailable"));
      if (failure === "headers") mocks.auditContextFromHeaders.mockRejectedValueOnce(new Error("headers unavailable"));
      if (failure === "revalidate") mocks.revalidatePath.mockImplementationOnce(() => {
        throw new Error("cache unavailable");
      });

      await expect(
        updatePendingManagementStatusAction(PREV, managementFormData()),
      ).resolves.toEqual({ error: null, ok: true });
    },
  );
});

// --------------------------------------------------------------------------
// Tramo comercial: contactar y facturar.
//
// Facturar es la transición que habilita la entrega y mueve cantidades, así que
// tiene que dejar rastro. Y tiene que ser SEGURA ante un fallo posterior al
// commit: si la auditoría o la revalidación caen después de que la factura ya
// quedó registrada, devolver un error haría que el vendedor reintente y
// termine facturando dos veces el mismo pedido.
// --------------------------------------------------------------------------
describe("contactPendingAction / invoicePendingAction", () => {
  function lifecycleFormData(overrides: Record<string, string> = {}) {
    const data = new FormData();
    data.set("id", "pend-1");
    for (const [key, value] of Object.entries(overrides)) data.set(key, value);
    return data;
  }

  it("registra la factura con actor, cantidad y estado resultante", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "sel-1", role: "OPERADOR" } });
    mocks.invoicePending.mockResolvedValue(null);

    const result = await invoicePendingAction(PREV, lifecycleFormData({ quantity: "6" }));

    expect(result).toEqual({ error: null, ok: true });
    expect(mocks.invoicePending).toHaveBeenCalledWith({
      id: "pend-1",
      quantity: 6,
      actorId: "sel-1",
      canManageAll: false,
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.PENDING_INVOICED,
        module: AUDIT_MODULES.PENDIENTES,
        entity: "Pending",
        entityId: "pend-1",
        after: { invoicedQuantity: 6, customerStatus: "FACTURADO" },
      }),
    );
  });

  it("audita el intento rechazado sobre un pendiente ajeno", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "sel-2", role: "OPERADOR" } });
    mocks.invoicePending.mockResolvedValue("NOT_OWNER");

    const result = await invoicePendingAction(PREV, lifecycleFormData({ quantity: "2" }));

    expect(result.ok).toBe(false);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.PENDING_INVOICED,
        result: "FAILURE",
        after: { reason: "NOT_OWNER", attemptedQuantity: 2 },
      }),
    );
  });

  it("no le pide a nadie que reintente una factura ya registrada", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "sel-1", role: "OPERADOR" } });
    mocks.invoicePending.mockResolvedValue(null);
    mocks.recordAudit.mockRejectedValueOnce(new Error("audit unavailable"));
    mocks.revalidatePath.mockImplementationOnce(() => {
      throw new Error("cache unavailable");
    });

    await expect(
      invoicePendingAction(PREV, lifecycleFormData({ quantity: "4" })),
    ).resolves.toEqual({ error: null, ok: true });
  });

  it("no le pide a nadie que reintente un contacto ya registrado", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "sel-1", role: "OPERADOR" } });
    mocks.contactPending.mockResolvedValue(null);
    mocks.auditContextFromHeaders.mockRejectedValueOnce(new Error("headers unavailable"));

    await expect(contactPendingAction(PREV, lifecycleFormData())).resolves.toEqual({
      error: null,
      ok: true,
    });
  });

  it("rechaza una cantidad a facturar que no sea un entero positivo", async () => {
    mocks.requireCapability.mockResolvedValue({ user: { id: "sel-1", role: "OPERADOR" } });

    for (const quantity of ["0", "-3", "2.5", "abc", ""]) {
      const result = await invoicePendingAction(PREV, lifecycleFormData({ quantity }));
      expect(result.ok).toBe(false);
    }
    expect(mocks.invoicePending).not.toHaveBeenCalled();
  });
});
