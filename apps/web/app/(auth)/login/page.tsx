import type { Metadata } from "next";

import { BrandLogo } from "@/app/_components/app-shell/brand-logo";
import { IlAsesoriasLogo } from "@/app/_components/app-shell/il-asesorias-logo";
import { Card } from "@/app/_components/ui/card";
import { LoginForm } from "@/features/auth/login-form";
import { IL_ASESORIAS } from "@/lib/constants/app";

export const metadata: Metadata = { title: "Ingresar" };

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
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

        <LoginForm />
      </Card>

      {/* Sello institucional del proveedor tecnológico (discreto, sobrio). */}
      <div className="flex w-full max-w-sm flex-col items-center gap-2 text-center">
        <a
          href={IL_ASESORIAS.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`${IL_ASESORIAS.name} — sitio web`}
          className="inline-block rounded-[var(--radius-btn)]"
        >
          <IlAsesoriasLogo className="h-auto w-32 sm:w-36" />
        </a>
        <p className="text-xs text-muted-foreground">{IL_ASESORIAS.developedBy}</p>
        <p className="text-xs text-muted-foreground">{IL_ASESORIAS.tic}</p>
      </div>
    </main>
  );
}
