import { z } from "zod";

import { USER_ROLES } from "@/lib/auth/permissions";

// Roles del modelo, re-exportados desde la fuente única de verdad
// (`@/lib/auth/permissions`). La validación de forma (Zod) acepta los roles; el
// techo por rango del actor es una regla del servicio, no del esquema.
export const ASSIGNABLE_ROLES = USER_ROLES;

// Etiquetas legibles para un gerente no técnico (nunca mostramos el enum crudo).
export const ROLE_LABELS: Record<(typeof ASSIGNABLE_ROLES)[number], string> = {
  SUPERADMIN: "Super Admin",
  ADMIN: "Administrador",
  SUPERVISOR: "Supervisor",
  OPERADOR: "Operador",
};

// Normalizamos (trim + minúsculas) ANTES de validar el formato del email, para
// que un espacio accidental no rompa el alta y los emails queden canónicos.
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Email inválido" }).max(160));

const nameField = z
  .string()
  .trim()
  .min(1, { error: "El nombre es obligatorio" })
  .max(120);

const roleField = z.enum(ASSIGNABLE_ROLES, { error: "Rol inválido" });

// Alta: el admin define la contraseña inicial (el usuario entra con ella).
export const userCreateSchema = z.object({
  name: nameField,
  email: emailField,
  password: z
    .string()
    .min(8, { error: "La contraseña debe tener al menos 8 caracteres" })
    .max(200),
  role: roleField,
});

const optionalPasswordField = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .min(8, { error: "La contraseña debe tener al menos 8 caracteres" })
    .max(200)
    .optional(),
);

// Edición: la contraseña es opcional; vacío significa conservar la actual.
export const userUpdateSchema = z.object({
  name: nameField,
  email: emailField,
  role: roleField,
  password: optionalPasswordField,
});

export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;
