import { describe, expect, it } from "vitest";

import { userCreateSchema, userUpdateSchema } from "./schema";

describe("userCreateSchema", () => {
  it("acepta un alta válida y normaliza el email", () => {
    const result = userCreateSchema.safeParse({
      name: "  Ana Gómez ",
      email: "  ANA@Example.COM ",
      password: "secret-123",
      role: "OPERADOR",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("ana@example.com");
      expect(result.data.name).toBe("Ana Gómez");
    }
  });

  it("rechaza email inválido", () => {
    expect(
      userCreateSchema.safeParse({
        name: "Ana",
        email: "no-es-email",
        password: "secret-123",
        role: "ADMIN",
      }).success,
    ).toBe(false);
  });

  it("rechaza contraseña corta (< 8)", () => {
    expect(
      userCreateSchema.safeParse({
        name: "Ana",
        email: "ana@example.com",
        password: "corta",
        role: "ADMIN",
      }).success,
    ).toBe(false);
  });

  it("rechaza rol fuera del enum", () => {
    expect(
      userCreateSchema.safeParse({
        name: "Ana",
        email: "ana@example.com",
        password: "secret-123",
        role: "SUPERUSER",
      }).success,
    ).toBe(false);
  });

  it("rechaza nombre vacío", () => {
    expect(
      userCreateSchema.safeParse({
        name: "   ",
        email: "ana@example.com",
        password: "secret-123",
        role: "OPERADOR",
      }).success,
    ).toBe(false);
  });

  it("acepta SUPERADMIN como rol asignable", () => {
    expect(
      userCreateSchema.safeParse({
        name: "Root",
        email: "root@example.com",
        password: "secret-123",
        role: "SUPERADMIN",
      }).success,
    ).toBe(true);
  });

  it("rechaza LIDER (rol eliminado del modelo)", () => {
    expect(
      userCreateSchema.safeParse({
        name: "Ana",
        email: "ana@example.com",
        password: "secret-123",
        role: "LIDER",
      }).success,
    ).toBe(false);
  });
});

describe("userUpdateSchema", () => {
  it("acepta una edición válida sin password", () => {
    const result = userUpdateSchema.safeParse({
      name: "Ana",
      email: "ana@example.com",
      role: "ADMIN",
    });
    expect(result.success).toBe(true);
  });
});
