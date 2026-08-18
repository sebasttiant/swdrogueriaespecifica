import {
  LayoutDashboard,
  Package,
  ClipboardList,
  ClipboardCheck,
  PackageX,
  PackagePlus,
  BarChart3,
  ShieldCheck,
  Users,
  Inbox,
  type LucideIcon,
} from "lucide-react";

import { can, type Capability } from "@/lib/auth/permissions";
import type { SessionRole } from "@/lib/auth/session";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  // Si true, se muestra en la barra inferior móvil (espacio limitado).
  primaryMobile?: boolean;
  // Capability que habilita el item. La visibilidad del nav se decide por lo que
  // un rol PUEDE HACER, nunca por rango: agregar un rol nuevo es una fila en la
  // matriz de capabilities, sin tocar esta lista.
  capability: Capability;
};

// Navegación principal del AppShell. Orden = importancia operativa.
export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, primaryMobile: true, capability: "canViewDashboard" },
  { label: "Pendientes", href: "/pendientes", icon: ClipboardList, primaryMobile: true, capability: "canViewPendientes" },
  { label: "Faltantes", href: "/faltantes", icon: PackageX, primaryMobile: true, capability: "canViewFaltantes" },
  // Sin `primaryMobile`: es una vista de gerencia, no debe ocupar un lugar en
  // la barra inferior del celular del vendedor.
  { label: "Revisión de faltantes", href: "/revision-faltantes", icon: Inbox, capability: "canReviewMissingReports" },
  // Va pegado al de faltantes porque son las dos superficies de revisión, y
  // tampoco ocupa lugar en la barra móvil. La diferencia con el de arriba es a
  // quién alcanza: esta la ve también el vendedor, acotada a sus propias filas.
  { label: "Revisión de pendientes", href: "/revision-pendientes", icon: ClipboardCheck, capability: "canReviewPendings" },
  { label: "Entradas", href: "/entradas", icon: PackagePlus, primaryMobile: true, capability: "canViewEntradas" },
  { label: "Productos", href: "/productos", icon: Package, capability: "canViewProductos" },
  { label: "Reportes", href: "/reportes", icon: BarChart3, capability: "canViewReports" },
  { label: "Usuarios", href: "/admin", icon: Users, capability: "canManageUsers" },
  { label: "Auditoría", href: "/auditoria", icon: ShieldCheck, capability: "canViewAudit" },
] as const;

// Items visibles según el rol de la sesión. Cada item se muestra solo si el rol
// tiene su capability (fuente única de verdad en `@/lib/auth/permissions`).
// Espeja el guard de la página: ocultar el link sin dejar de proteger el acceso.
// Sin sesión (role null/undefined) no se muestra nada que requiera capability.
export function visibleNavItems(
  role: SessionRole | null | undefined,
): readonly NavItem[] {
  if (role == null) return [];
  return NAV_ITEMS.filter((item) => can(role, item.capability));
}
