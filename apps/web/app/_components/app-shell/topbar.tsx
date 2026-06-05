import { UserCircle2 } from "lucide-react";

import { BrandLogo } from "./brand-logo";

// Topbar sticky. En celular muestra el logo (el sidebar está oculto).
// El botón de cuenta es un placeholder hasta que exista login (Fase 2).
export function Topbar() {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-surface/95 px-4 backdrop-blur lg:px-6">
      <BrandLogo className="h-7 w-auto lg:hidden" priority />
      <div className="hidden lg:block" />
      <button
        type="button"
        aria-label="Cuenta (disponible en Fase 2)"
        className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
      >
        <UserCircle2 className="size-7" aria-hidden />
      </button>
    </header>
  );
}
