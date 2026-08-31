import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { $queryRaw: mocks.queryRaw },
}));

import { GET } from "./route";

// --------------------------------------------------------------------------
// /api/ready — la respuesta que va a leer quien opera el despliegue.
//
// Lo que se fija acá es el CONTRATO hacia afuera: el código HTTP, lo que dice
// el cuerpo y —sobre todo— lo que el cuerpo NO puede decir. Este endpoint
// contesta sin autenticación.
// --------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/ready · la base contesta", () => {
  it("responde 200 y dice que está lista", async () => {
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.service).toBe("drogueria-especifica-web");
  });

  it("no se guarda en caché: una respuesta vieja describe un pasado", async () => {
    mocks.queryRaw.mockResolvedValue([{ ok: 1 }]);

    const res = await GET();

    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  // Una consulta que mira tablas fallaría durante una migración, que es justo
  // cuando hace falta distinguir "migrando" de "caída".
  it("consulta lo mínimo, sin tocar el esquema", async () => {
    mocks.queryRaw.mockResolvedValue([{ ok: 1 }]);

    await GET();

    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    const consulta = String(mocks.queryRaw.mock.calls[0]?.[0]);
    expect(consulta).toContain("SELECT 1");
  });
});

describe("/api/ready · la base no contesta", () => {
  it("responde 503, no 500: no es un error de la petición", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("connection refused"));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe("unavailable");
    expect(body.reason).toBe("unavailable");
  });

  it("el fallo queda registrado del lado del servidor", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("connection refused"));

    await GET();

    expect(console.error).toHaveBeenCalled();
  });

  // Lo más importante del endpoint. El mensaje de un error de conexión de
  // PostgreSQL nombra host, puerto, base y usuario, y esto contesta sin sesión.
  it("NO publica la cadena de conexión ni el error de la base", async () => {
    const url = "postgresql://drogueria:sup3rs3cr3t@10.0.0.5:5432/drogueria";
    mocks.queryRaw.mockRejectedValue(
      new Error(`Can't reach database server at ${url}`),
    );

    const res = await GET();
    const crudo = JSON.stringify(await res.json());

    expect(crudo).not.toContain("sup3rs3cr3t");
    expect(crudo).not.toContain("10.0.0.5");
    expect(crudo).not.toContain("drogueria:");
    expect(crudo).not.toContain("Can't reach database");
    expect(crudo).not.toContain("postgresql://");
  });

  it("tampoco publica un stack", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("boom"));

    const crudo = JSON.stringify(await (await GET()).json());

    expect(crudo).not.toContain("at ");
    expect(crudo).not.toContain(".ts:");
  });

  // Un fallo transitorio se INFORMA. No borra nada, no reinicia nada y no
  // dispara ninguna operación destructiva: solo cambia lo que responde.
  it("un fallo no escribe nada en la base", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("timeout"));

    await GET();

    // La única llamada a Prisma fue la consulta de lectura.
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("se recupera sola cuando la base vuelve", async () => {
    mocks.queryRaw.mockRejectedValueOnce(new Error("caída"));
    expect((await GET()).status).toBe(503);

    mocks.queryRaw.mockResolvedValue([{ ok: 1 }]);
    expect((await GET()).status).toBe(200);
  });
});
