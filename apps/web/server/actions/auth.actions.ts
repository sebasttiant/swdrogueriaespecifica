"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import {
  DEFAULT_AUTHENTICATED_ROUTE,
  LOGIN_ROUTE,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/config.edge";
import { signSession } from "@/lib/auth/jwt.edge";
import { getServerEnv } from "@/lib/env";
import { verifyCredentials } from "@/server/services/auth.service";

// --------------------------------------------------------------------------
// Server Actions de auth (finas).
//
// Slice 1a: validan con Zod, delegan en el service, firman el JWT y manejan la
// cookie httpOnly. La auditoría (LOGIN / LOGIN_FAILED / LOGOUT) se agrega en el
// slice 1b junto con el enforcement del middleware.
// --------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginState = { error: string | null };

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
    // TODO(1b): auditar AUDIT_ACTIONS.LOGIN_FAILED con ip/userAgent.
    return { error: "Correo o contraseña incorrectos." };
  }

  const token = await signSession(user);
  const { NODE_ENV } = getServerEnv();
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(NODE_ENV === "production"));

  // TODO(1b): auditar AUDIT_ACTIONS.LOGIN.
  redirect(DEFAULT_AUTHENTICATED_ROUTE);
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);

  // TODO(1b): auditar AUDIT_ACTIONS.LOGOUT.
  redirect(LOGIN_ROUTE);
}
