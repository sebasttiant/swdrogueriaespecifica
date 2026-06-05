import type { Metadata } from "next";

import { BrandLogo } from "@/app/_components/app-shell/brand-logo";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";

export const metadata: Metadata = { title: "Ingresar" };

// Placeholder de login (Fase 1). NO autentica: la lógica real (cookie httpOnly,
// hashing, sesión) se implementa en Fase 2. Sirve para fijar identidad visual.
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <BrandLogo className="h-12 w-auto" priority />
        </div>

        <div className="text-center">
          <h1 className="text-xl font-bold text-text">Ingresar</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Accedé para gestionar pendientes, faltantes e inventario.
          </p>
        </div>

        <form className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium text-text">
              Correo
            </label>
            <input
              id="email"
              type="email"
              disabled
              placeholder="nombre@drogueriaespecifica.com"
              className="min-h-11 w-full rounded-[var(--radius-btn)] border border-border bg-muted/40 px-3 text-base text-text placeholder:text-muted-foreground"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium text-text">
              Contraseña
            </label>
            <input
              id="password"
              type="password"
              disabled
              placeholder="••••••••"
              className="min-h-11 w-full rounded-[var(--radius-btn)] border border-border bg-muted/40 px-3 text-base text-text placeholder:text-muted-foreground"
            />
          </div>
          <Button type="button" size="lg" disabled className="w-full">
            Ingresar
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          El inicio de sesión se habilita en Fase 2.
        </p>
      </Card>
    </main>
  );
}
