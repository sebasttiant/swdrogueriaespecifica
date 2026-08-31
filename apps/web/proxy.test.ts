import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "@/lib/auth/config.edge";
import { signSession } from "@/lib/auth/jwt.edge";
import type { SessionUser } from "@/lib/auth/session";

import { config, proxy } from "./proxy";

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

// --------------------------------------------------------------------------
// Las sondas de infraestructura quedan FUERA del guard.
//
// No es una preferencia: quien consulta una sonda —una persona con psql al
// lado, un balanceador, `deploy.sh`— no tiene sesión. Si el proxy la atrapa,
// la respuesta es un redirect a /login, que no dice absolutamente nada sobre
// la base. Y lo peor es cómo se ve: HTTP 307, sin error, con toda la pinta de
// estar funcionando.
//
// Se prueba contra el `matcher` real y no contra una copia, porque el defecto
// que esto evita es exactamente que el endpoint y el matcher se separen.
// --------------------------------------------------------------------------
describe("proxy · qué rutas quedan fuera del guard", () => {
  const patron = config.matcher[0]!;
  const matcher = new RegExp(`^${patron}$`);

  it.each(["/api/health", "/api/ready"])("la sonda %s no pasa por el guard", (ruta) => {
    expect(matcher.test(ruta)).toBe(false);
  });

  it("las rutas de la aplicación siguen protegidas", () => {
    for (const ruta of ["/dashboard", "/pendientes", "/revision-pendientes", "/productos"]) {
      expect(matcher.test(ruta), `${ruta} quedó sin guard`).toBe(true);
    }
  });

  // La exclusión nombra rutas completas, no un prefijo: excluir todo `/api`
  // dejaría cualquier endpoint futuro sin sesión sin que nadie lo decida.
  it("no exime al resto de /api", () => {
    expect(matcher.test("/api/otra-cosa")).toBe(true);
  });
});
