"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { SessionRole } from "@/lib/auth/session";
import { visibleNavItems } from "@/lib/constants/nav";
import { cn } from "@/lib/utils/cn";

import { BrandLogo } from "./brand-logo";

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

type SidebarProps = {
  role: SessionRole | null;
};

// Sidebar SOLO desktop (lg+). En celular se usa la barra inferior (MobileNav).
export function Sidebar({ role }: SidebarProps) {
  const pathname = usePathname();
  const navItems = visibleNavItems(role);

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface lg:flex print:hidden">
      <div className="flex h-16 items-center border-b border-border px-5">
        <BrandLogo className="h-8 w-auto" priority />
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Navegación principal">
        {navItems.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-[var(--radius-btn)] px-3 py-2.5 text-base font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-text hover:bg-muted",
              )}
            >
              <Icon className="size-5 shrink-0" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
