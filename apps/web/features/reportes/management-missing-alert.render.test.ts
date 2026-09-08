import { beforeEach, describe, expect, it, vi } from "vitest";

// El aviso consulta la base al renderizar. Acá el foco es LO QUE PINTA —a quién
// se lo muestra y a dónde manda—, así que el cálculo se fija desde afuera.
const service = vi.hoisted(() => ({ getManagementMissingAlert: vi.fn() }));

vi.mock("@/server/services/reports.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/reports.service")>();
  return { ...actual, getManagementMissingAlert: service.getManagementMissingAlert };
});

import { renderToStaticMarkup } from "react-dom/server";

import { MISSING_QUEUE_PATH } from "@/features/faltantes/missing-scope";
import { staleMissingHref } from "@/features/faltantes/missing-stale";
import type { SessionRole } from "@/lib/auth/session";

import { ManagementMissingAlert } from "./management-missing-alert";

function alert(overrides: Partial<{ createdToday: number; unclosedOverThreshold: number; exceedsDailyThreshold: boolean; active: boolean }> = {}) {
  return {
    createdToday: 3,
    unclosedOverThreshold: 45,
    exceedsDailyThreshold: false,
    active: true,
    ...overrides,
  };
}

async function render(role: SessionRole): Promise<string> {
  const element = await ManagementMissingAlert({ role });
  return element ? renderToStaticMarkup(element) : "";
}

beforeEach(() => {
  vi.clearAllMocks();
  service.getManagementMissingAlert.mockResolvedValue(alert());
});

describe("ManagementMissingAlert", () => {
  // El defecto que esto arregla: el enlace decía "Revisar faltantes" y abría
  // `/faltantes`, que empieza por "Reportar faltante" y "Nuevo faltante". Quien
  // toca ese aviso viene a CERRAR 45, no a cargar el 46.
  it("manda a la cola de revisión, no a la pantalla de cargar uno nuevo", async () => {
    const html = await render("ADMIN");

    expect(html).toContain(MISSING_QUEUE_PATH);
    expect(html).not.toContain('href="/faltantes"');
  });

  // EL SEGUNDO DEFECTO DEL MISMO ENLACE. Llegar a la pantalla correcta no
  // alcanzaba: el aviso decía "45 llevan más de 8 h" y abría la cola ENTERA,
  // con esos 45 mezclados entre cientos y —peor— los más viejos al final,
  // porque la lista ordena por fecha descendente. Medido en producción el
  // 2026-09-07: el aviso reclamaba 86 y abría 126 repartidos en siete páginas.
  //
  // Un aviso es una promesa: "hay N de esto, tocá para verlos".
  it("abre la cola YA FILTRADA a los atrasados", async () => {
    const html = await render("ADMIN");

    expect(html).toContain(`href="${staleMissingHref()}"`);
  });

  it("dice cuántos faltantes llevan demasiado tiempo sin cerrarse", async () => {
    const html = await render("ADMIN");

    expect(html).toContain("Estos faltantes no se han cerrado");
    expect(html).toContain("45 faltantes llevan más de");
  });

  // Solo gerencia. Es un aviso sobre trabajo que nadie más puede hacer, y
  // mostrárselo al vendedor lo entrena a ignorar la franja roja.
  it.each<SessionRole>(["OPERADOR", "SUPERVISOR", "BODEGA"])(
    "no se le muestra a %s",
    async (role) => {
      expect(await render(role)).toBe("");
    },
  );

  it.each<SessionRole>(["ADMIN", "SUPERADMIN"])("se le muestra a %s", async (role) => {
    expect(await render(role)).not.toBe("");
  });

  it("no dibuja nada cuando no hay nada que avisar", async () => {
    service.getManagementMissingAlert.mockResolvedValue(
      alert({ unclosedOverThreshold: 0, active: false }),
    );

    expect(await render("ADMIN")).toBe("");
  });
});
