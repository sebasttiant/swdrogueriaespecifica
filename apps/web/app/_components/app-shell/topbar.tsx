import { getCurrentSession } from "@/lib/auth/index.node";

import { BrandLogo } from "./brand-logo";
import { NavDrawer } from "./nav-drawer";
import { TopbarSearch } from "./topbar-search";
import { UserMenu } from "./user-menu";

// Topbar sticky. En celular muestra el logo + hamburger (el sidebar está oculto).
// A la derecha, el menú de cuenta: muestra el usuario logueado y deja cerrar
// sesión. Server component: resuelve la sesión y la pasa al menú (client).
// NavDrawer es un client island que recibe el role como prop — no re-resuelve
// la sesión internamente.
// TopbarSearch es un client island: desktop inline form (lg+) + mobile overlay (<lg).
export async function Topbar() {
  const session = await getCurrentSession();
  const role = session?.user.role ?? null;

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-surface/95 px-4 backdrop-blur lg:px-6">
      {/* Left side: hamburger (<lg) + logo (<lg) */}
      <div className="flex items-center gap-2">
        <NavDrawer role={role} />
        <BrandLogo className="h-7 w-auto lg:hidden" priority />
      </div>
      {/* Center: desktop search (lg+). Mobile search icon rendered inside TopbarSearch (<lg). */}
      <TopbarSearch />
      {session ? (
        <UserMenu name={session.user.name} email={session.user.email} />
      ) : null}
    </header>
  );
}
