import { NextResponse } from "next/server";

// Healthcheck liviano para Docker/orquestador. NO toca la base (debe responder
// aunque la DB esté caída, para distinguir "web viva" de "DB caída").
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "drogueria-especifica-web",
    timestamp: new Date().toISOString(),
  });
}
