import { UserCircle2 } from "lucide-react";

import { logoutAction } from "@/server/actions/auth.actions";

import { BrandLogo } from "./brand-logo";

// Topbar sticky. En celular muestra el logo (el sidebar está oculto).
// El botón de cuenta cierra la sesión (server action). Se mantiene el mismo
// ícono y estilo: solo se cablea la función, sin tocar el diseño.
export function Topbar() {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-surface/95 px-4 backdrop-blur lg:px-6">
      <BrandLogo className="h-7 w-auto lg:hidden" priority />
      <div className="hidden lg:block" />
      <form action={logoutAction}>
        <button
          type="submit"
          aria-label="Cerrar sesión"
          className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
        >
          <UserCircle2 className="size-7" aria-hidden />
        </button>
      </form>
    </header>
  );
}
