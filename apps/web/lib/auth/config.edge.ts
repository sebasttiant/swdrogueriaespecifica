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

// Rutas accesibles sin sesión.
export const PUBLIC_ROUTES = ["/login"] as const;

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}
