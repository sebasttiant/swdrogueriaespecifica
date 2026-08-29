import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  checkCapability: vi.fn(),
  listArrivalNotices: vi.fn(),
  revalidatePath: vi.fn(),
}));

// Se mockea para PROBAR que no se llama: es una lectura, y revalidar desde acá
// multiplicaría el trabajo por cada vendedor que tenga la pantalla abierta.
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/auth/require-role", () => ({ checkCapability: mocks.checkCapability }));
vi.mock("@/server/services/arrival-notice.service", () => ({
  listArrivalNotices: mocks.listArrivalNotices,
}));

import { listArrivalNoticesAction } from "./arrival-notice.actions";

// --------------------------------------------------------------------------
// El destinatario sale de la SESIÓN, nunca del cliente.
//
// Un `recipientId` por parámetro sería una fuga directa: cualquiera pediría los
// avisos de cualquiera, con el nombre del cliente adentro. La forma más barata
// de que eso no pase es que el parámetro no exista, y estas pruebas lo fijan
// para que nadie lo agregue "por comodidad" más adelante.
// --------------------------------------------------------------------------

const aviso = {
  pendingId: "pend-1",
  productName: "Amoxicilina",
  quantity: 3,
  readyQuantity: 3,
  availabilityStatus: "DISPONIBLE_COMPLETO" as const,
  customerName: "Doña Marta",
  noticedAt: new Date("2026-08-28T12:00:00.000Z"),
};

function sesion(role: string, id = "vendedor-1") {
  return { ok: true, session: { user: { id, role, email: "v@x.test" } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listArrivalNotices.mockResolvedValue([aviso]);
});

describe("listArrivalNoticesAction · aislamiento", () => {
  // CASO N — no hay forma de pedir los avisos de otra persona.
  it("consulta SIEMPRE con el id de la sesión", async () => {
    mocks.checkCapability.mockResolvedValue(sesion("OPERADOR", "vendedor-1"));

    await listArrivalNoticesAction();

    expect(mocks.listArrivalNotices).toHaveBeenCalledWith("vendedor-1");
  });

  it("ignora cualquier argumento que el cliente intente pasar", async () => {
    mocks.checkCapability.mockResolvedValue(sesion("OPERADOR", "vendedor-1"));

    // La firma no acepta parámetros; el cast fuerza el intento que haría un
    // cliente manipulado. El id de la sesión tiene que ganar igual.
    await (listArrivalNoticesAction as unknown as (r: string) => Promise<unknown>)(
      "vendedor-2",
    );

    expect(mocks.listArrivalNotices).toHaveBeenCalledWith("vendedor-1");
    expect(mocks.listArrivalNotices).not.toHaveBeenCalledWith("vendedor-2");
  });

  it("rechaza sin sesión válida y no consulta nada", async () => {
    mocks.checkCapability.mockResolvedValue({ ok: false, reason: "NO_SESSION" });

    const result = await listArrivalNoticesAction();

    expect(result.ok).toBe(false);
    expect(mocks.listArrivalNotices).not.toHaveBeenCalled();
  });
});

describe("listArrivalNoticesAction · identidad del cliente", () => {
  // CASO O — la PII se recorta en el SERVIDOR. Mandarla para que la pantalla la
  // descarte sería mandarla igual: viaja por la red y queda en el payload.
  it("no envía el nombre del cliente a quien no puede verlo", async () => {
    mocks.checkCapability.mockResolvedValue(sesion("BODEGA"));

    const result = await listArrivalNoticesAction();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notices[0]?.customerName).toBeNull();
  });

  it("lo envía a quien sí puede verlo", async () => {
    mocks.checkCapability.mockResolvedValue(sesion("ADMIN"));

    const result = await listArrivalNoticesAction();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notices[0]?.customerName).toBe("Doña Marta");
  });
});

describe("listArrivalNoticesAction · fallos", () => {
  it("devuelve ok:false sin detalle cuando la lectura falla", async () => {
    mocks.checkCapability.mockResolvedValue(sesion("OPERADOR"));
    mocks.listArrivalNotices.mockRejectedValue(new Error("base caída"));

    const result = await listArrivalNoticesAction();

    expect(result).toEqual({ ok: false });
  });

  it("serializa la fecha como epoch para cruzar al cliente", async () => {
    mocks.checkCapability.mockResolvedValue(sesion("ADMIN"));

    const result = await listArrivalNoticesAction();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notices[0]?.noticedAt).toBe(aviso.noticedAt.getTime());
    }
  });
});

// --------------------------------------------------------------------------
// Un vendedor NUNCA recibe los avisos de otro.
//
// El aislamiento no depende de que la pantalla filtre: depende de con qué id se
// consulta, y ese id sale de la sesión. Dos sesiones distintas tienen que
// producir dos consultas distintas, sin excepción.
// --------------------------------------------------------------------------
describe("listArrivalNoticesAction · un vendedor no ve lo del otro", () => {
  it("cada sesión consulta con SU id", async () => {
    mocks.checkCapability.mockResolvedValue(sesion("OPERADOR", "vendedor-A"));
    await listArrivalNoticesAction();
    expect(mocks.listArrivalNotices).toHaveBeenLastCalledWith("vendedor-A");

    mocks.checkCapability.mockResolvedValue(sesion("OPERADOR", "vendedor-B"));
    await listArrivalNoticesAction();
    expect(mocks.listArrivalNotices).toHaveBeenLastCalledWith("vendedor-B");
  });

  // Ver la cola global es un eje de LECTURA de pendientes; el aviso de llegada
  // es personal —le dice a alguien que llame a SU cliente— y no se hereda por
  // tener más permisos.
  it("ni siquiera un ADMIN hereda los avisos de un vendedor", async () => {
    mocks.checkCapability.mockResolvedValue(sesion("ADMIN", "admin-1"));

    await listArrivalNoticesAction();

    expect(mocks.listArrivalNotices).toHaveBeenCalledWith("admin-1");
    expect(mocks.listArrivalNotices).not.toHaveBeenCalledWith("vendedor-1");
  });
});

// --------------------------------------------------------------------------
// Es una LECTURA. Lo que no hace importa tanto como lo que hace: se la va a
// llamar en bucle desde el navegador, y una acción de lectura que escribe algo
// —aunque sea revalidar una ruta— multiplica ese trabajo por cada vendedor
// conectado.
// --------------------------------------------------------------------------
describe("listArrivalNoticesAction · no muta nada", () => {
  it("no revalida rutas ni toca la caché", async () => {
    mocks.checkCapability.mockResolvedValue(sesion("OPERADOR"));

    await listArrivalNoticesAction();

    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("devuelve una respuesta mínima: solo los avisos", async () => {
    mocks.checkCapability.mockResolvedValue(sesion("ADMIN"));

    const result = await listArrivalNoticesAction();

    expect(Object.keys(result).sort()).toEqual(["notices", "ok"]);
  });

  it("el rechazo no filtra nada del error interno", async () => {
    mocks.checkCapability.mockResolvedValue(sesion("OPERADOR"));
    mocks.listArrivalNotices.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:5432 — password=secreto"),
    );

    const result = await listArrivalNoticesAction();

    expect(result).toEqual({ ok: false });
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(result)).not.toContain("secreto");
  });
});
