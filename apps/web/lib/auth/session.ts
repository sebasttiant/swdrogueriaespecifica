// Tipos de sesión — compartidos entre capa Edge y Node.
// Sin dependencias de runtime: seguro de importar en cualquier contexto.

export type SessionRole = "SUPERADMIN" | "ADMIN" | "OPERADOR";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: SessionRole;
};

export type Session = {
  user: SessionUser;
};
