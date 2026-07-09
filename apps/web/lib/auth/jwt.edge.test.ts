import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";

import { signSession, verifySession } from "./jwt.edge";
import type { SessionUser } from "./session";

// AUTH_SECRET debe existir antes de firmar/verificar (se lee en runtime).
beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-de-al-menos-32-caracteres-largo!";
});

const user: SessionUser = {
  id: "user_1",
  email: "admin@drogueriaespecifica.com",
  name: "Administrador",
  role: "ADMIN",
};

describe("jwt.edge", () => {
  it("firma y verifica una sesión (round-trip)", async () => {
    const token = await signSession(user);
    const session = await verifySession(token);

    expect(session).not.toBeNull();
    expect(session?.user).toEqual(user);
  });

  it("acepta SUPERVISOR como rol válido de sesión", async () => {
    const supervisor: SessionUser = { ...user, id: "sup-1", role: "SUPERVISOR" };
    const token = await signSession(supervisor);

    await expect(verifySession(token)).resolves.toEqual({ user: supervisor });
  });

  it("rechaza roles inválidos al verificar el token", async () => {
    const token = await new SignJWT({
      email: user.email,
      name: user.name,
      role: "LIDER",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

    expect(await verifySession(token)).toBeNull();
  });

  it("devuelve null ante un token malformado", async () => {
    expect(await verifySession("no-es-un-jwt")).toBeNull();
    expect(await verifySession("")).toBeNull();
  });

  it("devuelve null si el token fue manipulado", async () => {
    const token = await signSession(user);
    const tampered = `${token}x`;

    expect(await verifySession(tampered)).toBeNull();
  });

  it("devuelve null si la firma usa otro secreto", async () => {
    const token = await signSession(user);
    process.env.AUTH_SECRET = "otro-secreto-distinto-de-32-caracteres-min!";

    expect(await verifySession(token)).toBeNull();

    // restaurar para el resto de la suite
    process.env.AUTH_SECRET = "test-secret-de-al-menos-32-caracteres-largo!";
  });
});
