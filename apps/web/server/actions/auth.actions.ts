"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import {
  DEFAULT_AUTHENTICATED_ROUTE,
  LOGIN_ROUTE,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/config.edge";
import { getCurrentSession } from "@/lib/auth/index.node";
import { signSession } from "@/lib/auth/jwt.edge";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { getServerEnv } from "@/lib/env";
import { recordAudit, type AuditContext } from "@/server/services/audit.service";
import { verifyCredentials } from "@/server/services/auth.service";

// --------------------------------------------------------------------------
// Server Actions de auth (finas).
//
// Validan con Zod, delegan en el service, firman el JWT, manejan la cookie
// httpOnly y auditan (LOGIN / LOGIN_FAILED / LOGOUT) con ip + user-agent.
// --------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginState = { error: string | null };

// Contexto de auditoría a partir de los headers de la request.
async function auditContext(
  userId?: string | null,
): Promise<AuditContext> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    userId: userId ?? null,
    ip: forwarded ?? h.get("x-real-ip") ?? null,
    userAgent: h.get("user-agent") ?? null,
    channel: "web",
  };
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "Ingresá un correo y una contraseña válidos." };
  }

  const user = await verifyCredentials(parsed.data.email, parsed.data.password);
  if (!user) {
    await recordAudit({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      module: AUDIT_MODULES.AUTH,
      entity: "User",
      result: "FAILURE",
      after: { email: parsed.data.email },
      context: await auditContext(),
    });
    return { error: "Correo o contraseña incorrectos." };
  }

  const token = await signSession(user);
  const { NODE_ENV } = getServerEnv();
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(NODE_ENV === "production"));

  await recordAudit({
    action: AUDIT_ACTIONS.LOGIN,
    module: AUDIT_MODULES.AUTH,
    entity: "User",
    entityId: user.id,
    context: await auditContext(user.id),
  });

  redirect(DEFAULT_AUTHENTICATED_ROUTE);
}

export async function logoutAction(): Promise<void> {
  // Capturamos quién cierra sesión antes de borrar la cookie.
  const session = await getCurrentSession();

  const store = await cookies();
  store.delete(SESSION_COOKIE);

  await recordAudit({
    action: AUDIT_ACTIONS.LOGOUT,
    module: AUDIT_MODULES.AUTH,
    entity: "User",
    entityId: session?.user.id ?? null,
    context: await auditContext(session?.user.id),
  });

  redirect(LOGIN_ROUTE);
}
