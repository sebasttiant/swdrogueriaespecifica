import { describe, expect, it } from "vitest";

import {
  APP_DESCRIPTION,
  APP_NAME,
  BUSINESS_NAME,
  LOGIN_TAGLINE,
  PRODUCT_NAME,
} from "./app";

// --------------------------------------------------------------------------
// El nombre del producto, fijado en un solo lugar.
//
// "Específica GO" es el SOFTWARE; "Droguería Específica" es el NEGOCIO. Se
// prueban juntos porque el error que importa no es escribir mal uno, es
// reemplazar uno por el otro: el logo de la puerta no cambia de nombre porque
// el sistema haya crecido.
// --------------------------------------------------------------------------

describe("nombre del producto", () => {
  it("se escribe exactamente así", () => {
    expect(PRODUCT_NAME).toBe("Específica GO");
  });

  // Las tres variantes que aparecen solas cuando el nombre se escribe a mano en
  // cada pantalla.
  it("no admite las variantes que aparecen al escribirlo a mano", () => {
    expect(PRODUCT_NAME).not.toBe("Especifica GO");
    expect(PRODUCT_NAME).not.toBe("Específica Go");
    expect(PRODUCT_NAME).not.toBe("Especifica Go");
  });

  it("lleva acento y GO en mayúsculas", () => {
    expect(PRODUCT_NAME).toContain("Específica");
    expect(PRODUCT_NAME.endsWith("GO")).toBe(true);
  });
});

describe("nombre del negocio", () => {
  it("sigue siendo la droguería", () => {
    expect(BUSINESS_NAME).toBe("Droguería Específica");
  });

  // Lo que esta prueba defiende: el software cambió de nombre, el negocio no.
  it("no fue reemplazado por el del software", () => {
    expect(BUSINESS_NAME).not.toBe(PRODUCT_NAME);
    expect(BUSINESS_NAME).not.toContain("GO");
  });
});

describe("la bienvenida del login", () => {
  it("nombra al producto y habla de administrar la operación", () => {
    expect(LOGIN_TAGLINE).toBe("Accede a Específica GO para administrar tu operación.");
  });

  // El texto viejo ataba el producto a sus tres módulos de hoy. La plataforma
  // va a sumar más, y el nombre no puede quedarse describiendo el inventario.
  it("ya no se presenta como una app de tres módulos", () => {
    expect(LOGIN_TAGLINE).not.toContain("pendientes, faltantes e inventario");
  });

  it("se arma con la constante, no con el nombre escrito a mano", () => {
    expect(LOGIN_TAGLINE).toContain(PRODUCT_NAME);
  });
});

describe("metadata", () => {
  it("el título del navegador es el del software", () => {
    expect(APP_NAME).toBe(PRODUCT_NAME);
  });

  it("la descripción habla de plataforma, no de tres módulos", () => {
    expect(APP_DESCRIPTION).not.toContain("pendientes, faltantes e inventario");
    expect(APP_DESCRIPTION.toLowerCase()).toContain("plataforma");
  });
});
