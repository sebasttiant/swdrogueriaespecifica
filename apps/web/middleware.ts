import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  DEFAULT_AUTHENTICATED_ROUTE,
  isPublicRoute,
  LOGIN_ROUTE,
  SESSION_COOKIE,
} from "@/lib/auth/config.edge";
import { verifySession } from "@/lib/auth/jwt.edge";

// --------------------------------------------------------------------------
// Middleware EDGE-SAFE.
//
// Reglas:
//  - SIN Prisma, SIN imports Node-only.
//  - Verifica la sesión SOLO con la firma del JWT (`jose`), nunca toca la base.
//
// Slice 1b: enforcement real.
//  - Ruta pública + sesión válida → redirige al dashboard (no relogear).
//  - Ruta privada sin sesión válida → redirige al login.
// --------------------------------------------------------------------------

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
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
  // Excluye assets internos y el healthcheck (debe responder sin sesión).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
