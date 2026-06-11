"use server";

import { revalidatePath } from "next/cache";

import { requireActiveRole } from "@/lib/auth/require-role";
import { AUDIT_ACTIONS, AUDIT_MODULES } from "@/lib/constants/audit";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  auditContextFromHeaders,
  recordAudit,
} from "@/server/services/audit.service";
import {
  archiveUser,
  createUser,
  setUserActive,
  unarchiveUser,
  updateUser,
  UserRuleError,
  type UserRuleCode,
} from "@/server/services/user.service";
import {
  userCreateSchema,
  userUpdateSchema,
} from "@/features/admin/schema";

// --------------------------------------------------------------------------
// Server Actions de gestión de usuarios (finas): Zod →
// requireActiveRole(SUPERADMIN, ADMIN) → service → audit. Solo administradores:
// el enforcement DB-authoritative va antes de cualquier efecto.
// --------------------------------------------------------------------------

export type UserFormState = { error: string | null; ok: boolean };

const RULE_MESSAGES: Record<UserRuleCode, string> = {
  NOT_FOUND: "El usuario no existe.",
  SELF_DEACTIVATION: "No podés desactivar tu propia cuenta.",
  SELF_ROLE_CHANGE: "No podés cambiar tu propio rol.",
  LAST_ADMIN: "No se puede dejar el sistema sin un administrador activo.",
  SELF_ARCHIVE: "No podés archivar tu propia cuenta.",
  ALREADY_ARCHIVED: "El usuario ya está archivado.",
  NOT_ARCHIVED: "El usuario no está archivado.",
};

// P2002 (unique) sobre `email`: cubrimos target como array o string de constraint.
function isDuplicateEmailError(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes("email");
  if (typeof target === "string") return target.includes("email");
  return false;
}

export async function createUserAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const session = await requireActiveRole("SUPERADMIN", "ADMIN");

  const parsed = userCreateSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return { error: "Revisá los datos del usuario.", ok: false };
  }

  try {
    const user = await createUser(parsed.data);
    await recordAudit({
      action: AUDIT_ACTIONS.USER_CREATE,
      module: AUDIT_MODULES.USUARIOS,
      entity: "User",
      entityId: user.id,
      // NUNCA auditamos la contraseña: solo datos no sensibles.
      after: { name: user.name, email: user.email, role: user.role },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      return { error: "Ya existe un usuario con ese email.", ok: false };
    }
    console.error("[usuarios] No se pudo crear el usuario:", error);
    return { error: "No se pudo crear el usuario. Intentá de nuevo.", ok: false };
  }

  revalidatePath("/admin");
  return { error: null, ok: true };
}

export async function updateUserAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const session = await requireActiveRole("SUPERADMIN", "ADMIN");

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    return { error: "Usuario inválido.", ok: false };
  }

  const parsed = userUpdateSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return { error: "Revisá los datos del usuario.", ok: false };
  }

  try {
    await updateUser({
      id,
      actingUserId: session.user.id,
      input: parsed.data,
    });
    await recordAudit({
      action: AUDIT_ACTIONS.USER_UPDATE,
      module: AUDIT_MODULES.USUARIOS,
      entity: "User",
      entityId: id,
      after: parsed.data,
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    if (error instanceof UserRuleError) {
      return { error: RULE_MESSAGES[error.code], ok: false };
    }
    if (isDuplicateEmailError(error)) {
      return { error: "Ya existe un usuario con ese email.", ok: false };
    }
    console.error("[usuarios] No se pudo actualizar el usuario:", error);
    return { error: "No se pudo actualizar el usuario. Intentá de nuevo.", ok: false };
  }

  revalidatePath("/admin");
  revalidatePath(`/admin/${id}`);
  return { error: null, ok: true };
}

export async function setUserActiveAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const session = await requireActiveRole("SUPERADMIN", "ADMIN");

  const id = formData.get("id");
  const activeRaw = formData.get("active");
  if (typeof id !== "string" || id.length === 0) {
    return { error: "Usuario inválido.", ok: false };
  }
  // Parsing estricto: solo aceptamos los dos valores que emite el toggle; nunca
  // tratamos basura como "false" de forma silenciosa.
  if (activeRaw !== "true" && activeRaw !== "false") {
    return { error: "Acción inválida.", ok: false };
  }
  const active = activeRaw === "true";

  try {
    await setUserActive({ id, actingUserId: session.user.id, active });
    await recordAudit({
      action: active
        ? AUDIT_ACTIONS.USER_ACTIVATE
        : AUDIT_ACTIONS.USER_DEACTIVATE,
      module: AUDIT_MODULES.USUARIOS,
      entity: "User",
      entityId: id,
      after: { active },
      context: await auditContextFromHeaders(session.user.id),
    });
  } catch (error) {
    if (error instanceof UserRuleError) {
      return { error: RULE_MESSAGES[error.code], ok: false };
    }
    console.error("[usuarios] No se pudo cambiar el estado del usuario:", error);
    return { error: "No se pudo cambiar el estado. Intentá de nuevo.", ok: false };
  }

  revalidatePath("/admin");
  return { error: null, ok: true };
}

// --------------------------------------------------------------------------
// Archivar usuario — SUPERADMIN only (soft-delete).
// --------------------------------------------------------------------------

export async function archiveUserAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  // Solo SUPERADMIN puede archivar; capturamos la sesión para el audit.
  const session = await requireActiveRole("SUPERADMIN");

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    return { error: "Usuario inválido.", ok: false };
  }

  try {
    await archiveUser({ id, actingUserId: session.user.id });
    // Auditoría best-effort: si falla no revierte el archivado.
    await recordAudit({
      action: AUDIT_ACTIONS.USER_ARCHIVE,
      module: AUDIT_MODULES.USUARIOS,
      entity: "User",
      entityId: id,
      after: { archivedAt: new Date().toISOString() },
      context: await auditContextFromHeaders(session.user.id),
    }).catch((err) => {
      console.error("[usuarios] No se pudo registrar auditoría de archivo:", err);
    });
  } catch (error) {
    if (error instanceof UserRuleError) {
      return { error: RULE_MESSAGES[error.code], ok: false };
    }
    console.error("[usuarios] No se pudo archivar el usuario:", error);
    return { error: "No se pudo archivar el usuario. Intentá de nuevo.", ok: false };
  }

  revalidatePath("/admin");
  return { error: null, ok: true };
}

// --------------------------------------------------------------------------
// Restaurar usuario archivado — SUPERADMIN only.
// --------------------------------------------------------------------------

export async function unarchiveUserAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  // Solo SUPERADMIN puede restaurar; capturamos la sesión para el audit.
  const session = await requireActiveRole("SUPERADMIN");

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    return { error: "Usuario inválido.", ok: false };
  }

  try {
    await unarchiveUser({ id });
    // Auditoría best-effort.
    await recordAudit({
      action: AUDIT_ACTIONS.USER_RESTORE,
      module: AUDIT_MODULES.USUARIOS,
      entity: "User",
      entityId: id,
      after: { archivedAt: null },
      context: await auditContextFromHeaders(session.user.id),
    }).catch((err) => {
      console.error("[usuarios] No se pudo registrar auditoría de restauración:", err);
    });
  } catch (error) {
    if (error instanceof UserRuleError) {
      return { error: RULE_MESSAGES[error.code], ok: false };
    }
    console.error("[usuarios] No se pudo restaurar el usuario:", error);
    return { error: "No se pudo restaurar el usuario. Intentá de nuevo.", ok: false };
  }

  revalidatePath("/admin");
  return { error: null, ok: true };
}
