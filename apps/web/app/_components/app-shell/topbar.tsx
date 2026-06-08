import { getCurrentSession } from "@/lib/auth/index.node";

import { BrandLogo } from "./brand-logo";
import { UserMenu } from "./user-menu";

// Topbar sticky. En celular muestra el logo (el sidebar está oculto).
// A la derecha, el menú de cuenta: muestra el usuario logueado y deja cerrar
// sesión. Server component: resuelve la sesión y la pasa al menú (client).
export async function Topbar() {
  const session = await getCurrentSession();

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-surface/95 px-4 backdrop-blur lg:px-6">
      <BrandLogo className="h-7 w-auto lg:hidden" priority />
      <div className="hidden lg:block" />
      {session ? (
        <UserMenu name={session.user.name} email={session.user.email} />
      ) : null}
    </header>
  );
}
