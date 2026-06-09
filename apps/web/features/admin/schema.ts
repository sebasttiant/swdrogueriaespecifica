import { z } from "zod";

// Roles asignables por el admin. Espeja el enum UserRole de Prisma; esta lista
// es la fuente de verdad para los formularios (no hay permisos granulares aún).
export const ASSIGNABLE_ROLES = ["ADMIN", "LIDER", "OPERADOR"] as const;

// Etiquetas legibles para un gerente no técnico (nunca mostramos el enum crudo).
export const ROLE_LABELS: Record<(typeof ASSIGNABLE_ROLES)[number], string> = {
  ADMIN: "Administrador",
  LIDER: "Líder",
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

// Edición: datos del usuario. La contraseña no se cambia en este slice.
export const userUpdateSchema = z.object({
  name: nameField,
  email: emailField,
  role: roleField,
});

export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;
