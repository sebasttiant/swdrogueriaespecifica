import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "@/lib/auth/config.edge";
import { signSession } from "@/lib/auth/jwt.edge";
import type { SessionUser } from "@/lib/auth/session";

import { proxy } from "./proxy";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-de-al-menos-32-caracteres-largo!";
});

const user: SessionUser = {
  id: "user_1",
  email: "admin@drogueriaespecifica.com",
  name: "Administrador",
  role: "ADMIN",
};

function requestFor(path: string, token?: string): NextRequest {
  const request = new NextRequest(new URL(`http://localhost${path}`));
  if (token) request.cookies.set(SESSION_COOKIE, token);
  return request;
}

describe("proxy", () => {
  it("deja pasar rutas públicas sin sesión", async () => {
    const res = await proxy(requestFor("/login"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("deja pasar un asset estático público sin sesión", async () => {
    const res = await proxy(requestFor("/logo-especifica.webp"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirige a /login una ruta privada sin sesión", async () => {
    const res = await proxy(requestFor("/dashboard"));
    expect(res.headers.get("location")).toContain("/login");
  });

  it("redirige a /login si el token es inválido", async () => {
    const res = await proxy(requestFor("/dashboard", "token-basura"));
    expect(res.headers.get("location")).toContain("/login");
  });

  it("deja pasar una ruta privada con sesión válida", async () => {
    const token = await signSession(user);
    const res = await proxy(requestFor("/dashboard", token));
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirige al dashboard si un usuario con sesión visita /login", async () => {
    const token = await signSession(user);
    const res = await proxy(requestFor("/login", token));
    expect(res.headers.get("location")).toContain("/dashboard");
  });
});
