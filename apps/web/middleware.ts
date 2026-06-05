import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { isPublicRoute } from "@/lib/auth/config.edge";

// --------------------------------------------------------------------------
// Middleware EDGE-SAFE.
//
// Reglas:
//  - SIN Prisma.
//  - SIN imports Node-only.
//  - Solo protege rutas (no consulta la base).
//
// Fase 1: PLACEHOLDER. No bloquea (todavía no hay login). El contrato queda
// listo: en Fase 2, si la ruta no es pública y falta cookie de sesión válida,
// se redirige a LOGIN_ROUTE usando únicamente APIs de Edge.
// --------------------------------------------------------------------------

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (isPublicRoute(pathname)) {
    return NextResponse.next();
  }

  // TODO(Fase 2): exigir cookie httpOnly de sesión válida; si falta, redirigir
  // a LOGIN_ROUTE. En Fase 1 dejamos pasar para no romper la navegación base.
  return NextResponse.next();
}

export const config = {
  // Excluye assets internos y el healthcheck (debe responder sin sesión).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
