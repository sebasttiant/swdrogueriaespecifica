import { describe, expect, it, vi } from "vitest";

import { READINESS_TIMEOUT_MS, checkReadiness } from "./readiness";

// --------------------------------------------------------------------------
// La regla de readiness, probada sin base y sin servidor.
//
// Lo que se fija acá es lo que NO se puede probar contra una base de verdad sin
// romperla a propósito: qué pasa cuando la consulta falla, cuando no vuelve, y
// qué sale —sobre todo, qué NO sale— en la respuesta.
// --------------------------------------------------------------------------

describe("readiness · la base contesta", () => {
  it("está lista", async () => {
    expect(await checkReadiness(async () => [{ ok: 1 }])).toEqual({ ready: true });
  });

  // Lo que importa es que la consulta TERMINE, no qué devolvió. Atarlo a un
  // valor concreto convertiría un cambio de sonda en una caída falsa.
  it("no le importa qué devolvió la consulta", async () => {
    for (const valor of [undefined, null, 0, "", []]) {
      expect(await checkReadiness(async () => valor)).toEqual({ ready: true });
    }
  });
});

describe("readiness · la base no contesta", () => {
  it("no está lista cuando la consulta falla", async () => {
    const resultado = await checkReadiness(async () => {
      throw new Error("connection refused");
    });

    expect(resultado).toEqual({ ready: false, reason: "unavailable" });
  });

  it("tampoco cuando ni siquiera se puede llamar a la sonda", async () => {
    const resultado = await checkReadiness(() => {
      // Un cliente que no se construye porque falta configuración: tira de
      // forma SÍNCRONA, antes de devolver una promesa.
      throw new Error("falta AUTH_SECRET");
    });

    expect(resultado).toEqual({ ready: false, reason: "unavailable" });
  });

  it("distingue el vencimiento de un fallo", async () => {
    const resultado = await checkReadiness(() => new Promise(() => {}), {
      timeoutMs: 20,
    });

    expect(resultado).toEqual({ ready: false, reason: "timeout" });
  });

  it("no espera para siempre: una consulta colgada vence", async () => {
    const empezo = Date.now();
    await checkReadiness(() => new Promise(() => {}), { timeoutMs: 30 });

    expect(Date.now() - empezo).toBeLessThan(1_000);
  });

  it("nunca propaga: un chequeo de salud que explota no informa nada", async () => {
    await expect(
      checkReadiness(async () => {
        throw new Error("boom");
      }),
    ).resolves.toBeTruthy();
  });
});

describe("readiness · qué se publica y qué no", () => {
  // El endpoint contesta SIN autenticación. El mensaje de un error de conexión
  // de PostgreSQL nombra host, puerto, base y usuario.
  it("el resultado no lleva nada del error", async () => {
    const secreto = "postgresql://usuario:sup3rs3cr3t@10.0.0.5:5432/drogueria";
    const resultado = await checkReadiness(async () => {
      throw new Error(`no se pudo conectar a ${secreto}`);
    });

    const serializado = JSON.stringify(resultado);
    expect(serializado).not.toContain("sup3rs3cr3t");
    expect(serializado).not.toContain("10.0.0.5");
    expect(serializado).not.toContain("no se pudo conectar");
    expect(resultado).toEqual({ ready: false, reason: "unavailable" });
  });

  // Pero el error SÍ tiene que llegar a algún lado, o el fallo se vuelve un
  // misterio. Va al log del servidor, que es privado.
  it("el error completo se le entrega a quien lo tiene que registrar", async () => {
    const onError = vi.fn();
    const causa = new Error("connection refused");

    await checkReadiness(async () => {
      throw causa;
    }, { onError });

    expect(onError).toHaveBeenCalledWith(causa);
  });

  it("no se registra nada cuando todo anda", async () => {
    const onError = vi.fn();
    await checkReadiness(async () => [{ ok: 1 }], { onError });

    expect(onError).not.toHaveBeenCalled();
  });
});

describe("readiness · el vencimiento no deja basura", () => {
  // Un rechazo que llega DESPUÉS de que ganó el vencimiento queda sin manejar
  // si no se lo atrapa, y según el runtime puede tumbar el proceso: el chequeo
  // de salud causaría la caída que vino a detectar.
  it("un fallo tardío no queda sin manejar", async () => {
    const sinManejar = vi.fn();
    process.on("unhandledRejection", sinManejar);

    const resultado = await checkReadiness(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("tarde")), 30)),
      { timeoutMs: 5 },
    );
    expect(resultado).toEqual({ ready: false, reason: "timeout" });

    await new Promise((r) => setTimeout(r, 80));
    process.off("unhandledRejection", sinManejar);

    expect(sinManejar).not.toHaveBeenCalled();
  });

  it("el temporizador se limpia cuando la sonda gana", async () => {
    const clear = vi.spyOn(global, "clearTimeout");
    await checkReadiness(async () => [{ ok: 1 }]);

    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});

describe("readiness · el límite por defecto", () => {
  it("es corto: un readiness lento ya no sirve para decidir", () => {
    expect(READINESS_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(READINESS_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
