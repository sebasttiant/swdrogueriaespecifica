import { DeploymentGuard } from "@/features/deployment/deployment-guard";
import type { ReactNode } from "react";

import { AppShell } from "@/app/_components/app-shell/app-shell";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  // El guard envuelve TODO el panel: el desfase de versión no es de una
  // pantalla, es del build entero, y cualquier mutación hecha desde una pestaña
  // vieja falla igual. Montarlo por pantalla dejaría huecos justo en las que
  // nadie se acordó de tocar.
  return (
    <DeploymentGuard>
      <AppShell>{children}</AppShell>
    </DeploymentGuard>
  );
}
