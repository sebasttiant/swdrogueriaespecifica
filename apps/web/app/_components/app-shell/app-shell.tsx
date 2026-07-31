import type { ReactNode } from "react";

import { AlertBar } from "@/features/alertas/alert-bar";
import { BackLink } from "./back-link";
import { ManagementMissingAlert } from "@/features/reportes/management-missing-alert";
import { getCurrentSession } from "@/lib/auth/index.node";
import { IL_ASESORIAS } from "@/lib/constants/app";

import { MobileNav } from "./mobile-nav";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

type AppShellProps = {
  children: ReactNode;
};

// Estructura responsive principal.
//  - Desktop (lg+): sidebar lateral + contenido.
//  - Celular: topbar + contenido + barra inferior fija.
// El padding inferior reserva espacio para la MobileNav fija en celular, más el
// safe-area inferior (home indicator / barra del navegador) vía env().
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
        {session ? (
          <div className="print:hidden">
            <ManagementMissingAlert role={session.user.role} />
            <AlertBar userId={session.user.id} role={session.user.role} />
          </div>
        ) : null}
        <main className="flex-1 px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-5 lg:px-8 lg:pb-8">
          <div className="mx-auto w-full max-w-5xl">
            <BackLink />
            {children}
          </div>
          {/* Atribución institucional discreta (solo texto, sin logo). */}
          <footer className="mx-auto mt-10 w-full max-w-5xl border-t border-border pt-4 text-center text-xs text-muted-foreground print:hidden">
            {IL_ASESORIAS.copyright}
          </footer>
        </main>
      </div>
      <MobileNav role={role} />
    </div>
  );
}
