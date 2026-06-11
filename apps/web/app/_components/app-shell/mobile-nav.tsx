"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { SessionRole } from "@/lib/auth/session";
import { visibleNavItems } from "@/lib/constants/nav";
import { cn } from "@/lib/utils/cn";

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

type MobileNavProps = {
  role: SessionRole | null;
};

// Barra inferior fija — SOLO celular/tablet (oculta en lg+).
// Muestra las acciones principales con áreas táctiles grandes.
export function MobileNav({ role }: MobileNavProps) {
  const pathname = usePathname();
  const items = visibleNavItems(role).filter((item) => item.primaryMobile);

  // Derive column count dynamically from items rendered.
  // Using inline style for gridTemplateColumns avoids relying on Tailwind JIT
  // to generate arbitrary `grid-cols-N` classes at runtime.
  const colCount = Math.max(1, items.length);

  return (
    <nav
      aria-label="Navegación principal"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
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
              <Link
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
      </ul>
    </nav>
  );
}
