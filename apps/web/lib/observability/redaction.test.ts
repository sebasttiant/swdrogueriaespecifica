import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeText, hashEmail, maskPhone } from "./redaction";
import { isSupportCode, newSupportCode } from "./support-code";

describe("hashEmail", () => {
  it("da la misma identidad para el mismo correo, sin exponerlo", () => {
    const hash = hashEmail("Daniel@Drogueriaespecifica.com");

    expect(hash).toBe(hashEmail("  daniel@drogueriaespecifica.com  "));
    expect(hash).not.toContain("daniel");
    expect(hash).not.toContain("@");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("distingue usuarios distintos", () => {
    expect(hashEmail("uno@x.com")).not.toBe(hashEmail("dos@x.com"));
  });

  // Se llama desde el camino de logging: un ausente no puede tirar una excepción
  // que termine tumbando el registro de un pendiente.
  it("tolera ausencia en vez de romper el log", () => {
    expect(hashEmail(undefined)).toBe("anon");
    expect(hashEmail(null)).toBe("anon");
    expect(hashEmail("   ")).toBe("anon");
  });
});

describe("maskPhone", () => {
  it("deja solo los últimos cuatro dígitos", () => {
    expect(maskPhone("301 6325273")).toBe("***5273");
    expect(maskPhone("3016325273")).toBe("***5273");
  });

  // Enmascarar "los últimos 4" de un número de 4 dígitos sería mostrarlo entero.
  it("oculta por completo un número demasiado corto para enmascarar", () => {
    expect(maskPhone("3016")).toBe("***");
    expect(maskPhone("")).toBe("***");
  });
});

describe("describeText", () => {
  it("reporta presencia y tamaño, nunca el contenido", () => {
    expect(describeText("Va con pedido de Fitostimoline")).toBe("len:30");
    expect(describeText("")).toBe("empty");
    expect(describeText(undefined)).toBe("empty");
  });
});

describe("newSupportCode", () => {
  it("tiene la forma que el operador dicta y el runbook filtra", () => {
    const code = newSupportCode();
    expect(code).toMatch(/^PND-[2-9A-HJ-NP-TV-Z]{6}$/);
    expect(isSupportCode(code)).toBe(true);
  });

  // Se dicta por teléfono: I/L/O/U/0/1 se confunden al hablar.
  it("no usa caracteres que se confunden al dictarlos", () => {
    const codes = Array.from({ length: 200 }, () => newSupportCode().slice(4));
    expect(codes.join("")).not.toMatch(/[ILOU01]/);
  });

  it("no repite el código entre intentos", () => {
    const codes = new Set(Array.from({ length: 500 }, newSupportCode));
    expect(codes.size).toBe(500);
  });
});

// --------------------------------------------------------------------------
// El incidente lo reportó una persona concreta, y la tentación de "arreglarlo
// para ese usuario" es real. Esta prueba la cierra: si alguien mete un correo
// literal en el flujo de pendientes, falla acá y explica por qué.
// --------------------------------------------------------------------------
describe("el flujo de pendientes no tiene lógica atada a un usuario", () => {
  const SOURCES = [
    "../../server/actions/pending.actions.ts",
    "../../server/services/pending.service.ts",
    "../../features/pendientes/pending-form.tsx",
    "../../lib/auth/require-role.ts",
  ];

  it.each(SOURCES)("%s no contiene direcciones de correo literales", (relative) => {
    const source = readFileSync(
      fileURLToPath(new URL(relative, import.meta.url)),
      "utf8",
    );
    // Cualquier `algo@dominio.tld` en el código de este flujo es una excepción
    // por usuario disfrazada. El acceso se decide por capability, no por correo.
    expect(source).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});
