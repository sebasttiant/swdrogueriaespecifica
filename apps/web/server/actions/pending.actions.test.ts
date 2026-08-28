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
  linkOrionCodeAtCapture: vi.fn(),
  linkOrionCode: vi.fn(),
  findProductById: vi.fn(),
  findOrCreateLaboratory: vi.fn(),
  logPendingEvent: vi.fn(),
  SkuConcurrencyError: class SkuConcurrencyError extends Error {
    constructor() {
      super("sku identity changed under us");
      this.name = "SkuConcurrencyError";
    }
  },
  ManualProductIdentityConflictError: class ManualProductIdentityConflictError extends Error {
    constructor(readonly holder: { id: string; name: string }) {
      super("orion code already belongs to another product");
      this.name = "ManualProductIdentityConflictError";
    }
  },
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
  ManualProductIdentityConflictError: mocks.ManualProductIdentityConflictError,
  registerPending: mocks.registerPending,
  setPendingManagementStatus: mocks.setPendingManagementStatus,
}));
vi.mock("@/server/services/sku-onboarding.service", () => ({
  linkOrionCodeAtCapture: mocks.linkOrionCodeAtCapture,
  linkOrionCode: mocks.linkOrionCode,
}));
vi.mock("@/server/repositories/product.repository", () => ({
  findProductById: mocks.findProductById,
}));
vi.mock("@/server/repositories/laboratory.repository", () => ({
  findOrCreateLaboratory: mocks.findOrCreateLaboratory,
}));
vi.mock("@/server/repositories/sku-review.repository", () => ({
  SkuConcurrencyError: mocks.SkuConcurrencyError,
}));
// Se conservan las constantes reales y se espía SOLO la emisión: comprobar el
// log contra sus propios nombres canónicos, no contra cadenas copiadas acá.
vi.mock("@/lib/observability/pending-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/observability/pending-log")>();
  return { ...actual, logPendingEvent: mocks.logPendingEvent };
});

import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
// El error del DOMINIO es puro (no toca Prisma), así que se usa el real: un
// doble haría pasar el `instanceof` de la acción sin probar que coincide.
import { SkuIdentityError } from "@/server/domain/catalog/sku-identity";
import { PENDING_STAGES } from "@/lib/observability/pending-log";
import {
  cancelPendingAction,
  contactPendingAction,
  createPendingAction,
  deliverPendingAction,
  invoicePendingAction,
  resolvePendingIdentityAction,
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
  // Producto del catálogo por defecto: YA identificado. Es el caso al que la
  // exigencia de identidad no le pide nada, así que los tests que no vienen a
  // hablar de identidad siguen probando lo suyo sin arrastrarla. Los que sí
  // vienen a hablar de identidad lo reemplazan por uno sin código.
  mocks.findProductById.mockResolvedValue({
    id: "prod-1",
    name: "Acetaminofén 500mg",
    orionCode: "ORN-9000",
    identityVersion: 1,
  });
  // Laboratorio por defecto: existe y se resuelve directo.
  mocks.findOrCreateLaboratory.mockResolvedValue({
    status: "exists",
    laboratory: { id: "lab-1", name: "Lab Test", searchKey: "lab test" },
  });
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
  data.set("requestedLaboratoryId", "lab-1");
  data.set("requestedLaboratoryName", "LabTest");
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
  data.set("requestedLaboratoryId", "lab-1");
  data.set("requestedLaboratoryName", "LabTest");
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

    // El producto manual nace sin identidad, así que este alta tiene que
    // resolverla: acá se aplaza, que es la otra salida válida.
    const result = await createPendingAction(
      PREV,
      createManualFormData({ identitySkippedReason: "CODE_NOT_FOUND" }),
    );

    expectSuccess(result);
    expect(mocks.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: undefined,
        manual: { name: "Ibuprofeno jarabe", unit: "frasco" },
      }),
    );
  });

  // ------------------------------------------------------------------------
  // S2b · 1e-B — la acción HONRA la identidad cuando viene.
  //
  // Todavía no la EXIGE: exigirla antes de que la pantalla pueda satisfacerla
  // rechazaría capturas que hoy funcionan. Eso llega con el formulario.
  // ------------------------------------------------------------------------
  describe("identidad Orion", () => {
    beforeEach(() => {
      mocks.findProductById.mockResolvedValue({
        id: "prod-1",
        name: "Eucerin tono claro",
        orionCode: null,
        identityVersion: 3,
      });
      mocks.linkOrionCodeAtCapture.mockResolvedValue({
        status: "LINKED",
        product: { id: "prod-1", orionCode: "ORN-1001", identityVersion: 4 },
      });
    });

    it("vincula el código al producto del catálogo declarando la versión observada", async () => {
      await createPendingAction(PREV, createCatalogFormData({ orionCode: "ORN-1001" }));

      expect(mocks.linkOrionCodeAtCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          identity: { productId: "prod-1" },
          orionCode: "ORN-1001",
          // La versión que se leyó es el compare-and-set: sin declararla, dos
          // capturas simultáneas se pisarían la identidad sin enterarse.
          expectedVersion: 3,
          actor: expect.objectContaining({ id: "op-1", role: "OPERADOR" }),
        }),
      );
      expect(mocks.registerPending).toHaveBeenCalled();
    });

    it("devuelve el dueño estructurado y preserva todo el pedido ante conflicto de catálogo", async () => {
      mocks.linkOrionCodeAtCapture.mockResolvedValue({
        status: "ORION_CONFLICT",
        holder: { id: "prod-9", name: "Eucerin tono medio" },
      });

      const result = await createPendingAction(
        PREV,
        createCatalogFormData({
          orionCode: "ORN-1001",
          customerAddress: "Calle 10 #20-30",
          note: "Entregar en portería",
          zone: "Centro",
          totalAmount: "45.000",
          paidAmount: "20.000",
        }),
      );

      expect(result.ok).toBe(false);
      // Sin el nombre, al operador solo le queda adivinar cuál producto tiene
      // el código: el nombre es lo que convierte el rechazo en una salida.
      expect(result.error).toContain("Eucerin tono medio");
      expect(result.orionConflict).toEqual({
        holder: { productId: "prod-9", productName: "Eucerin tono medio" },
      });
      expect(mocks.registerPending).not.toHaveBeenCalled();
      // Y lo tipeado vuelve: corregir la identidad no puede costar volver a
      // cargar el pedido entero.
      expect(result.values).toEqual({
        productId: "prod-1",
        manualName: "",
        manualUnit: "",
        manualMode: "",
        quantity: "2",
        promisedAt: "2099-01-02T12:00",
        customerName: "Ana Pérez",
        customerPhone: "3001234567",
        customerAddress: "Calle 10 #20-30",
        note: "Entregar en portería",
        zone: "Centro",
        totalAmount: "45.000",
        paidAmount: "20.000",
        idempotencyKey: ATTEMPT_UUID,
        orionCode: "ORN-1001",
        identitySkippedReason: "",
        identitySkippedNote: "",
        requestedLaboratoryId: "lab-1",
        requestedLaboratoryName: "LabTest",
      });
    });

    it("un aplazamiento llega al service como motivo y nota, sin tocar el producto", async () => {
      await createPendingAction(
        PREV,
        createCatalogFormData({
          identitySkippedReason: "ORION_UNAVAILABLE",
          identitySkippedNote: "Orion no responde",
        }),
      );

      expect(mocks.linkOrionCodeAtCapture).not.toHaveBeenCalled();
      expect(mocks.registerPending).toHaveBeenCalledWith(
        expect.objectContaining({
          identitySkippedReason: "ORION_UNAVAILABLE",
          identitySkippedNote: "Orion no responde",
        }),
      );
    });

    it("el producto manual lleva el código en su alta, no por una vinculación aparte", async () => {
      await createPendingAction(PREV, createManualFormData({ orionCode: "ORN-2002" }));

      expect(mocks.linkOrionCodeAtCapture).not.toHaveBeenCalled();
      expect(mocks.registerPending).toHaveBeenCalledWith(
        expect.objectContaining({
          manual: { name: "Ibuprofeno jarabe", unit: "frasco", orionCode: "ORN-2002" },
        }),
      );
    });

    it("un rol sin autoridad para vincular se rechaza ANTES de cualquier escritura", async () => {
      mocks.checkCapability.mockImplementation(async (capability: string) =>
        capability === "canLinkProductIdentity"
          ? { ok: false, reason: "FORBIDDEN" }
          : { ok: true, session: { user: { id: "op-1", role: "OPERADOR", email: "op1@drogueria.test" } } },
      );

      const result = await createPendingAction(
        PREV,
        createCatalogFormData({ orionCode: "ORN-1001" }),
      );

      expect(result.ok).toBe(false);
      expect(mocks.linkOrionCodeAtCapture).not.toHaveBeenCalled();
      expect(mocks.registerPending).not.toHaveBeenCalled();
      expect(result.values?.orionCode).toBe("ORN-1001");
    });

    it("aplazar NO exige autoridad de vinculación: no escribe identidad de nadie", async () => {
      mocks.checkCapability.mockImplementation(async (capability: string) =>
        capability === "canLinkProductIdentity"
          ? { ok: false, reason: "FORBIDDEN" }
          : { ok: true, session: { user: { id: "op-1", role: "OPERADOR", email: "op1@drogueria.test" } } },
      );

      const result = await createPendingAction(
        PREV,
        createCatalogFormData({ identitySkippedReason: "CODE_NOT_FOUND" }),
      );

      expectSuccess(result);
      expect(mocks.registerPending).toHaveBeenCalled();
    });

    it("devuelve el dueño estructurado y preserva todo el pedido manual en conflicto", async () => {
      mocks.registerPending.mockRejectedValue(
        new mocks.ManualProductIdentityConflictError({ id: "prod-9", name: "Eucerin tono medio" }),
      );

      const result = await createPendingAction(
        PREV,
        createManualFormData({
          manualMode: "on",
          orionCode: "ORN-2002",
          customerAddress: "Carrera 5 #6-70",
          note: "Llamar antes",
          zone: "Norte",
          totalAmount: "60.000",
          paidAmount: "10.000",
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Eucerin tono medio");
      expect(result.orionConflict).toEqual({
        holder: { productId: "prod-9", productName: "Eucerin tono medio" },
      });
      expect(result.values).toEqual({
        productId: "",
        manualName: "Ibuprofeno jarabe",
        manualUnit: "frasco",
        manualMode: "on",
        quantity: "2",
        promisedAt: "2099-01-02T12:00",
        customerName: "Ana Pérez",
        customerPhone: "3001234567",
        customerAddress: "Carrera 5 #6-70",
        note: "Llamar antes",
        zone: "Norte",
        totalAmount: "60.000",
        paidAmount: "10.000",
        idempotencyKey: ATTEMPT_UUID,
        orionCode: "ORN-2002",
        identitySkippedReason: "",
        identitySkippedNote: "",
        requestedLaboratoryId: "lab-1",
        requestedLaboratoryName: "LabTest",
      });
    });

    it("la unión de identidad NO viaja al service: el contrato son los campos planos", async () => {
      await createPendingAction(PREV, createCatalogFormData({ orionCode: "ORN-1001" }));

      const [input] = mocks.registerPending.mock.calls[0] as [Record<string, unknown>];
      expect(input).not.toHaveProperty("identity");
      expect(input).not.toHaveProperty("orionCode");
    });

    // Estos tres casos NO devuelven: TIRAN. Una excepción que escapa de una
    // Server Action se lleva puesto el eco de los valores, que es exactamente
    // el incidente de julio/agosto de 2026 que este archivo existe para
    // impedir. Devolver un estado accionable no es cortesía: es el contrato.
    it("el producto que ya tiene OTRO código no revienta la acción", async () => {
      mocks.linkOrionCodeAtCapture.mockRejectedValue(
        new SkuIdentityError("ORION_CONFLICT"),
      );

      const result = await createPendingAction(
        PREV,
        createCatalogFormData({ orionCode: "ORN-1001" }),
      );

      expect(result.ok).toBe(false);
      expect(result.values?.orionCode).toBe("ORN-1001");
      expect(mocks.registerPending).not.toHaveBeenCalled();
    });

    it("perder el compare-and-set se informa como tal, no como un fallo genérico", async () => {
      mocks.linkOrionCodeAtCapture.mockRejectedValue(new mocks.SkuConcurrencyError());

      const result = await createPendingAction(
        PREV,
        createCatalogFormData({ orionCode: "ORN-1001" }),
      );

      expect(result.ok).toBe(false);
      // "Volvé a intentar en unos segundos" sería mentira: reintentar sin
      // mirar qué quedó puesto vuelve a perder. Hay que refrescar.
      expect(result.error).toMatch(/refresc|recarg/i);
      expect(result.values?.orionCode).toBe("ORN-1001");
    });

    it("el producto que ya no existe se informa sin perder lo tipeado", async () => {
      mocks.findProductById.mockResolvedValue(null);

      const result = await createPendingAction(
        PREV,
        createCatalogFormData({ orionCode: "ORN-1001" }),
      );

      expect(result.ok).toBe(false);
      expect(result.values?.orionCode).toBe("ORN-1001");
      expect(mocks.registerPending).not.toHaveBeenCalled();
    });

    it("el vínculo ya existente (NOOP) sigue de largo y registra", async () => {
      mocks.linkOrionCodeAtCapture.mockResolvedValue({
        status: "NOOP",
        product: { id: "prod-1", orionCode: "ORN-1001", identityVersion: 3 },
      });

      const result = await createPendingAction(
        PREV,
        createCatalogFormData({ orionCode: "ORN-1001" }),
      );

      expectSuccess(result);
      expect(mocks.registerPending).toHaveBeenCalled();
    });

    it("si el registro falla DESPUÉS de vincular, el vínculo queda registrado en el log", async () => {
      mocks.registerPending.mockRejectedValue(new Error("boom"));

      const result = await createPendingAction(
        PREV,
        createCatalogFormData({ orionCode: "ORN-1001" }),
      );

      expect(result.ok).toBe(false);
      // El código YA quedó puesto en el producto y el pendiente no existe. Si
      // el log no lo dice, soporte no puede responder "¿se aplicó el código?"
      // con el código de soporte en la mano, que es para lo único que sirve.
      const stages = mocks.logPendingEvent.mock.calls.map(
        ([event]) => (event as { stage?: string }).stage,
      );
      expect(stages).toContain(PENDING_STAGES.IDENTITY_LINKED);
    });

    it("una sesión vencida al vincular NO se disfraza de falta de permiso", async () => {
      mocks.checkCapability.mockImplementation(async (capability: string) =>
        capability === "canLinkProductIdentity"
          ? { ok: false, reason: "NO_SESSION" }
          : { ok: true, session: { user: { id: "op-1", role: "OPERADOR", email: "op1@drogueria.test" } } },
      );

      const result = await createPendingAction(
        PREV,
        createCatalogFormData({ orionCode: "ORN-1001" }),
      );

      expect(result.ok).toBe(false);
      // Decirle "pedile permiso a un administrador" a quien solo se le venció
      // la sesión lo manda a perseguir un permiso que ya tiene.
      expect(result.error).toMatch(/sesión/i);
    });

    // ----------------------------------------------------------------------
    // S2b · 1e-D — la exigencia se ACTIVA, y se decide contra la base.
    //
    // La pantalla ya pide el código, pero una pantalla no es una regla: el
    // FormData lo arma cualquiera y `fetch` no ve validaciones de React. Lo
    // único que decide acá es la identidad que el producto tiene HOY en la
    // base, releída en esta misma acción.
    // ----------------------------------------------------------------------
    it("el producto sin código no entra sin código ni aplazamiento", async () => {
      const result = await createPendingAction(PREV, createCatalogFormData());

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/código de Orion/i);
      expect(mocks.registerPending).not.toHaveBeenCalled();
      expect(mocks.linkOrionCodeAtCapture).not.toHaveBeenCalled();
      // La salida es elegir una de las dos, no volver a cargar el pedido.
      expect(result.values?.customerName).toBe("Ana Pérez");
    });

    it("un envío directo no puede saltear lo que la pantalla exige", async () => {
      // Espacios en el código y motivo vacío: exactamente lo que llega cuando
      // alguien arma el FormData a mano para esquivar el campo obligatorio.
      const result = await createPendingAction(
        PREV,
        createCatalogFormData({ orionCode: "   ", identitySkippedReason: "" }),
      );

      expect(result.ok).toBe(false);
      expect(mocks.registerPending).not.toHaveBeenCalled();
      expect(mocks.linkOrionCodeAtCapture).not.toHaveBeenCalled();
    });

    it("el producto que YA tiene código entra sin volver a vincular nada", async () => {
      mocks.findProductById.mockResolvedValue({
        id: "prod-1",
        name: "Eucerin tono claro",
        orionCode: "ORN-777",
        identityVersion: 5,
      });

      const result = await createPendingAction(PREV, createCatalogFormData());

      expectSuccess(result);
      expect(mocks.linkOrionCodeAtCapture).not.toHaveBeenCalled();
    });

    it("el producto que YA tiene código no admite un aplazamiento fabricado", async () => {
      // El aplazamiento es la salida de quien NO tiene el código. Sobre un
      // producto ya identificado no es una salida: es un "seguimos sin
      // identificarlo" guardado para siempre encima de algo que sí lo está.
      // La pantalla no ofrece el control acá, así que esto solo llega de un
      // FormData armado a mano o de un envío viejo que quedó atrás.
      mocks.findProductById.mockResolvedValue({
        id: "prod-1",
        name: "Eucerin tono claro",
        orionCode: "ORN-777",
        identityVersion: 5,
      });

      const result = await createPendingAction(
        PREV,
        createCatalogFormData({
          identitySkippedReason: "ORION_UNAVAILABLE",
          identitySkippedNote: "Orion caído desde las 10",
        }),
      );

      expect(result.ok).toBe(false);
      // Vuelve EXACTO lo enviado: resolver la contradicción no puede costar
      // volver a cargar el pedido entero.
      expect(result.values?.identitySkippedReason).toBe("ORION_UNAVAILABLE");
      expect(result.values?.identitySkippedNote).toBe("Orion caído desde las 10");
      expect(mocks.registerPending).not.toHaveBeenCalled();
      expect(mocks.linkOrionCodeAtCapture).not.toHaveBeenCalled();
      expect(mocks.recordAudit).not.toHaveBeenCalled();
    });

    it("el producto manual exige lo mismo: no existe, no puede tener código", async () => {
      const result = await createPendingAction(PREV, createManualFormData());

      expect(result.ok).toBe(false);
      expect(mocks.registerPending).not.toHaveBeenCalled();
      expect(result.values?.manualName).toBe("Ibuprofeno jarabe");
    });

    it("el manual aplazado entra y persiste el motivo y la nota exactos", async () => {
      const result = await createPendingAction(
        PREV,
        createManualFormData({
          identitySkippedReason: "ORION_UNAVAILABLE",
          identitySkippedNote: "Orion sin conexión desde las 9",
        }),
      );

      expectSuccess(result);
      expect(mocks.registerPending).toHaveBeenCalledWith(
        expect.objectContaining({
          identitySkippedReason: "ORION_UNAVAILABLE",
          identitySkippedNote: "Orion sin conexión desde las 9",
        }),
      );
      expect(mocks.linkOrionCodeAtCapture).not.toHaveBeenCalled();
    });

    it("el código Y el aplazamiento juntos se rechazan sin escribir nada", async () => {
      const result = await createPendingAction(
        PREV,
        createCatalogFormData({
          orionCode: "ORN-1001",
          identitySkippedReason: "CODE_NOT_FOUND",
        }),
      );

      expect(result.ok).toBe(false);
      expect(mocks.registerPending).not.toHaveBeenCalled();
      expect(mocks.linkOrionCodeAtCapture).not.toHaveBeenCalled();
    });
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

// --------------------------------------------------------------------------
// resolvePendingIdentityAction (S2b · 2-B2)
// --------------------------------------------------------------------------

function resolveFormData(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("productId", "prod-1");
  data.set("expectedVersion", "2");
  data.set("orionCode", "ORN-1001");
  for (const [key, value] of Object.entries(overrides)) {
    data.set(key, value);
  }
  return data;
}

const SESSION = { user: { id: "admin-1", role: "ADMIN" } };

describe("resolvePendingIdentityAction · guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkCapability.mockResolvedValue({ ok: true, session: SESSION });
    mocks.linkOrionCode.mockResolvedValue({ id: "prod-1", orionCode: "ORN-1001", identityVersion: 3 });
  });

  it("pasa por checkCapability('canFixProductIdentity')", async () => {
    await resolvePendingIdentityAction(PREV, resolveFormData());

    expect(mocks.checkCapability).toHaveBeenCalledWith("canFixProductIdentity");
  });

  it("rechaza si el guard dice NO_SESSION", async () => {
    mocks.checkCapability.mockResolvedValue({ ok: false, reason: "NO_SESSION" });

    const result = await resolvePendingIdentityAction(PREV, resolveFormData());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("sesión");
    expect(mocks.linkOrionCode).not.toHaveBeenCalled();
  });

  it("rechaza si el guard dice FORBIDDEN", async () => {
    mocks.checkCapability.mockResolvedValue({ ok: false, reason: "FORBIDDEN" });

    const result = await resolvePendingIdentityAction(PREV, resolveFormData());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("permiso");
    expect(mocks.linkOrionCode).not.toHaveBeenCalled();
  });
});

describe("resolvePendingIdentityAction · validación", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkCapability.mockResolvedValue({ ok: true, session: SESSION });
    mocks.linkOrionCode.mockResolvedValue({ id: "prod-1", orionCode: "ORN-1001", identityVersion: 3 });
  });

  it("rechaza un código de Orion con espacios", async () => {
    const result = await resolvePendingIdentityAction(PREV, resolveFormData({ orionCode: "ORN 1001" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("espacios");
    expect(mocks.linkOrionCode).not.toHaveBeenCalled();
  });

  it("rechaza un productId vacío", async () => {
    const result = await resolvePendingIdentityAction(PREV, resolveFormData({ productId: "" }));
    expect(result.ok).toBe(false);
    expect(mocks.linkOrionCode).not.toHaveBeenCalled();
  });

  it("rechaza un expectedVersion no numérico", async () => {
    const result = await resolvePendingIdentityAction(PREV, resolveFormData({ expectedVersion: "abc" }));
    expect(result.ok).toBe(false);
    expect(mocks.linkOrionCode).not.toHaveBeenCalled();
  });
});

describe("resolvePendingIdentityAction · escritura", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkCapability.mockResolvedValue({ ok: true, session: SESSION });
    mocks.linkOrionCode.mockResolvedValue({ id: "prod-1", orionCode: "ORN-1001", identityVersion: 3 });
  });

  it("llama a linkOrionCode con LINK intent y la identidad correcta", async () => {
    await resolvePendingIdentityAction(PREV, resolveFormData());

    expect(mocks.linkOrionCode).toHaveBeenCalledWith({
      actor: { id: "admin-1", role: "ADMIN" },
      context: expect.anything(),
      expectedVersion: 2,
      identity: { productId: "prod-1" },
      intent: "LINK",
      orionCode: "ORN-1001",
    });
  });

  it("devuelve ok:true y revalida las rutas correctas", async () => {
    const result = await resolvePendingIdentityAction(PREV, resolveFormData());

    expect(result).toEqual({ error: null, ok: true });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/productos/prod-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/productos");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/revision-identidad-pendientes");
  });

  it("maneja SkuConcurrencyError devolviendo el mensaje de concurrencia", async () => {
    mocks.linkOrionCode.mockRejectedValue(new mocks.SkuConcurrencyError());

    const result = await resolvePendingIdentityAction(PREV, resolveFormData());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cambió");
  });

  it("maneja SkuIdentityError devolviendo el mensaje del código", async () => {
    mocks.linkOrionCode.mockRejectedValue(new SkuIdentityError("ORION_CONFLICT"));

    const result = await resolvePendingIdentityAction(PREV, resolveFormData());
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("maneja errores inesperados con mensaje genérico", async () => {
    mocks.linkOrionCode.mockRejectedValue(new Error("unexpected"));

    const result = await resolvePendingIdentityAction(PREV, resolveFormData());
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// --------------------------------------------------------------------------
// El laboratorio solicitado es OPCIONAL (decisión de negocio).
//
// Lo que importa acá NO es solo que deje pasar: es que cuando no hay
// laboratorio NO se toque el catálogo. Volver opcional el schema sin cortar la
// resolución convertiría un error visible en una fila basura: un laboratorio
// con nombre vacío que después nadie puede buscar ni borrar.
// --------------------------------------------------------------------------
describe("createPendingAction · laboratorio opcional", () => {
  // La sesión y el registro los arma el `beforeEach` del describe principal,
  // que este bloque no hereda por estar al mismo nivel.
  beforeEach(() => {
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

  // CASO C — se crea el pendiente.
  it("crea el pendiente cuando no se informó laboratorio", async () => {
    const data = createCatalogFormData({
      requestedLaboratoryId: "",
      requestedLaboratoryName: "",
    });

    const result = await createPendingAction(PREV, data);

    expectSuccess(result);
  });

  // CASO E — no se intenta resolver nada.
  it("NO invoca findOrCreateLaboratory cuando no hay laboratorio", async () => {
    const data = createCatalogFormData({
      requestedLaboratoryId: "",
      requestedLaboratoryName: "",
    });

    await createPendingAction(PREV, data);

    expect(mocks.findOrCreateLaboratory).not.toHaveBeenCalled();
  });

  // CASO D — el pendiente queda sin laboratorio, no con uno inventado.
  it("registra el pendiente con el laboratorio ausente", async () => {
    const data = createCatalogFormData({
      requestedLaboratoryId: "",
      requestedLaboratoryName: "",
    });

    await createPendingAction(PREV, data);

    expect(mocks.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({ requestedLaboratoryId: undefined }),
    );
  });

  // CASO 5 — solo espacios es ausencia. Sin esto se crearía un laboratorio con
  // nombre en blanco.
  it("un nombre de solo espacios no toca el catálogo", async () => {
    const data = createCatalogFormData({
      requestedLaboratoryId: "",
      requestedLaboratoryName: "   ",
    });

    const result = await createPendingAction(PREV, data);

    expectSuccess(result);
    expect(mocks.findOrCreateLaboratory).not.toHaveBeenCalled();
  });

  // CASO F — el nombre escrito a mano sigue resolviéndose como antes.
  it("sigue resolviendo el laboratorio escrito a mano", async () => {
    const data = createCatalogFormData({
      requestedLaboratoryId: "",
      requestedLaboratoryName: "Tecnoquimicas",
    });

    await createPendingAction(PREV, data);

    expect(mocks.findOrCreateLaboratory).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Tecnoquimicas" }),
    );
  });

  // CASO G — la sugerencia seleccionada gana y no se vuelve a resolver.
  it("usa el ID seleccionado sin volver a resolver por nombre", async () => {
    const data = createCatalogFormData();

    await createPendingAction(PREV, data);

    expect(mocks.findOrCreateLaboratory).not.toHaveBeenCalled();
    expect(mocks.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({ requestedLaboratoryId: "lab-1" }),
    );
  });

  // El pendiente manual toma el mismo camino: sin laboratorio también entra.
  // El manual necesita identidad —código o aplazamiento— por la regla del SKU,
  // que es ajena al laboratorio y no se toca acá.
  it("acepta un producto manual sin laboratorio", async () => {
    const data = createManualFormData({
      identitySkippedReason: "CODE_NOT_FOUND",
      requestedLaboratoryId: "",
      requestedLaboratoryName: "",
    });

    const result = await createPendingAction(PREV, data);

    expectSuccess(result);
    expect(mocks.findOrCreateLaboratory).not.toHaveBeenCalled();
  });
});
