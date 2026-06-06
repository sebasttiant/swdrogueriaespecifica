// --------------------------------------------------------------------------
// Configuración de auth EDGE-SAFE.
//
// Reglas (Fase 1):
//  - NO importar Prisma.
//  - NO importar nada Node-only.
//  - Solo datos/funciones puras que pueda usar `middleware.ts` (runtime Edge).
//
// La lógica real de verificación de sesión vive en `index.node.ts` (Node-only).
// --------------------------------------------------------------------------

export const LOGIN_ROUTE = "/login";
export const DEFAULT_AUTHENTICATED_ROUTE = "/dashboard";

// Cookie de sesión httpOnly. El nombre y las opciones son datos puros, seguros
// de importar tanto en Edge (middleware) como en Node (server actions).
export const SESSION_COOKIE = "ds_session";

// 2 horas, alineado con la expiración del JWT (ver jwt.edge.ts).
export const SESSION_MAX_AGE = 60 * 60 * 2;

export type SessionCookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
};

export function sessionCookieOptions(
  isProduction: boolean,
): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}

// Rutas accesibles sin sesión.
export const PUBLIC_ROUTES = ["/login"] as const;

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}
