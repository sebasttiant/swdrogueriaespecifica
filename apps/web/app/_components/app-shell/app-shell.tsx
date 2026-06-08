import type { ReactNode } from "react";

import { getCurrentSession } from "@/lib/auth/index.node";

import { MobileNav } from "./mobile-nav";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

type AppShellProps = {
  children: ReactNode;
};

// Estructura responsive principal.
//  - Desktop (lg+): sidebar lateral + contenido.
//  - Celular: topbar + contenido + barra inferior fija.
// El padding inferior (pb-24) reserva espacio para la MobileNav en celular.
//
// Server component: resuelve el rol y se lo pasa a la navegación para ocultar
// los módulos admin-only (p. ej. Auditoría) a quien no corresponde.
export async function AppShell({ children }: AppShellProps) {
  const session = await getCurrentSession();
  const role = session?.user.role ?? null;

  return (
    <div className="flex min-h-dvh bg-background">
      <Sidebar role={role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 px-4 pb-24 pt-5 lg:px-8 lg:pb-8">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>
      </div>
      <MobileNav role={role} />
    </div>
  );
}
