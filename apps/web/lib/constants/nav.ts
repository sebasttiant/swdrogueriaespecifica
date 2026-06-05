import {
  LayoutDashboard,
  Package,
  ClipboardList,
  PackageX,
  PackagePlus,
  BarChart3,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  // Si true, se muestra en la barra inferior móvil (espacio limitado).
  primaryMobile?: boolean;
};

// Navegación principal del AppShell. Orden = importancia operativa.
export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, primaryMobile: true },
  { label: "Pendientes", href: "/pendientes", icon: ClipboardList, primaryMobile: true },
  { label: "Faltantes", href: "/faltantes", icon: PackageX, primaryMobile: true },
  { label: "Entradas", href: "/entradas", icon: PackagePlus, primaryMobile: true },
  { label: "Productos", href: "/productos", icon: Package },
  { label: "Reportes", href: "/reportes", icon: BarChart3 },
  { label: "Auditoría", href: "/auditoria", icon: ShieldCheck },
] as const;
