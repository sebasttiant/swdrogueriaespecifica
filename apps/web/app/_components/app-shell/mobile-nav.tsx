"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MoreHorizontal } from "lucide-react";

import type { SessionRole } from "@/lib/auth/session";
import { visibleNavItems } from "@/lib/constants/nav";
import { cn } from "@/lib/utils/cn";

import { OPEN_NAV_DRAWER_EVENT } from "./nav-drawer";

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function openNavDrawer() {
  window.dispatchEvent(new Event(OPEN_NAV_DRAWER_EVENT));
}

type MobileNavProps = {
  role: SessionRole | null;
};

// Barra inferior fija — SOLO celular/tablet (oculta en lg+).
// Muestra las acciones principales con áreas táctiles grandes.
export function MobileNav({ role }: MobileNavProps) {
  const pathname = usePathname();
  const items = visibleNavItems(role).filter((item) => item.primaryMobile);

  // Derive column count dynamically from items rendered, +1 for the "Más" tab.
  // Using inline style for gridTemplateColumns avoids relying on Tailwind JIT
  // to generate arbitrary `grid-cols-N` classes at runtime.
  const colCount = Math.max(1, items.length + 1);

  return (
    <nav
      aria-label="Navegación principal"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden print:hidden"
    >
      <ul
        className="grid"
        style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}
      >
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link prefetch={false}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-16 flex-col items-center justify-center gap-1 px-1 py-2 text-xs font-medium",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <Icon className="size-6" aria-hidden />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
        {/* "Más": abre el menú lateral con el resto de módulos (Productos,
            Reportes, y los admin-only). Bottom bar acotada a 4 tabs + Más
            (patrón iOS) para no encoger las áreas táctiles en iPhone. */}
        <li>
          <button
            type="button"
            onClick={openNavDrawer}
            aria-label="Más opciones"
            className="flex min-h-16 w-full flex-col items-center justify-center gap-1 px-1 py-2 text-xs font-medium text-muted-foreground"
          >
            <MoreHorizontal className="size-6" aria-hidden />
            <span className="truncate">Más</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
