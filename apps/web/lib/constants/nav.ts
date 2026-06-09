import {
  LayoutDashboard,
  Package,
  ClipboardList,
  PackageX,
  PackagePlus,
  BarChart3,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { SessionRole } from "@/lib/auth/session";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  // Si true, se muestra en la barra inferior móvil (espacio limitado).
  primaryMobile?: boolean;
  // Si true, solo lo ven los administradores (SUPERADMIN/ADMIN); módulos
  // sensibles, p. ej. Auditoría.
  adminOnly?: boolean;
};

// Navegación principal del AppShell. Orden = importancia operativa.
export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, primaryMobile: true },
  { label: "Pendientes", href: "/pendientes", icon: ClipboardList, primaryMobile: true },
  { label: "Faltantes", href: "/faltantes", icon: PackageX, primaryMobile: true },
  { label: "Entradas", href: "/entradas", icon: PackagePlus, primaryMobile: true },
  { label: "Productos", href: "/productos", icon: Package },
  { label: "Reportes", href: "/reportes", icon: BarChart3 },
  { label: "Usuarios", href: "/admin", icon: Users, adminOnly: true },
  { label: "Auditoría", href: "/auditoria", icon: ShieldCheck, adminOnly: true },
] as const;

// Items visibles según el rol de la sesión. Los módulos `adminOnly` (Usuarios,
// Auditoría) solo aparecen para administradores (SUPERADMIN/ADMIN); sin sesión o
// con otro rol quedan ocultos. Espeja el guard de ruta de la página: ocultar el
// link sin dejar de proteger el acceso.
const ADMIN_ROLES: readonly SessionRole[] = ["SUPERADMIN", "ADMIN"];

export function visibleNavItems(
  role: SessionRole | null | undefined,
): readonly NavItem[] {
  const isAdmin = role != null && ADMIN_ROLES.includes(role);
  return NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);
}
