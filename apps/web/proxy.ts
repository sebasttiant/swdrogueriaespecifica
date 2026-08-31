import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  DEFAULT_AUTHENTICATED_ROUTE,
  isPublicAsset,
  isPublicRoute,
  LOGIN_ROUTE,
  SESSION_COOKIE,
} from "@/lib/auth/config.edge";
import { verifySession } from "@/lib/auth/jwt.edge";

// --------------------------------------------------------------------------
// Proxy (antes `middleware`, renombrado en Next 16). Runtime: nodejs.
//
// Reglas:
//  - SIN Prisma, SIN imports Node-only.
//  - Verifica la sesión SOLO con la firma del JWT (`jose`, Web Crypto), nunca
//    toca la base.
//
// Slice 1b: enforcement real.
//  - Ruta pública + sesión válida → redirige al dashboard (no relogear).
//  - Ruta privada sin sesión válida → redirige al login.
// --------------------------------------------------------------------------

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Static assets from /public (logo, favicon, etc.) are public: never gate them
  // behind the session, or unauthenticated pages like /login lose their assets.
  if (isPublicAsset(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;

  if (isPublicRoute(pathname)) {
    if (session) {
      return NextResponse.redirect(
        new URL(DEFAULT_AUTHENTICATED_ROUTE, request.url),
      );
    }
    return NextResponse.next();
  }

  if (!session) {
    return NextResponse.redirect(new URL(LOGIN_ROUTE, request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Excluye assets internos de Next, el healthcheck, el endpoint de versión y
  // los archivos estáticos de /public (rutas de un solo segmento con extensión:
  // /logo-especifica.webp, /favicon.ico, ...). Las rutas de app son sin
  // extensión y siguen protegidas.
  //
  // `api/version` va afuera por la misma razón que el healthcheck: lo consulta
  // una pestaña que puede haber perdido la sesión durante el despliegue, y ese
  // es justamente el caso que tiene que detectar. Detrás del guard devolvería
  // un redirect al login en vez de la versión, y el desfase quedaría invisible.
  // No expone nada: solo el SHA del build, que ya viaja en cada asset.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health|api/version|[^/]+\\.[^/]+$).*)",
  ],
};
