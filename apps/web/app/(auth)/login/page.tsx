import type { Metadata } from "next";

import { BrandLogo } from "@/app/_components/app-shell/brand-logo";
import { Card } from "@/app/_components/ui/card";
import { LoginForm } from "@/features/auth/login-form";

export const metadata: Metadata = { title: "Ingresar" };

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

        <LoginForm />
      </Card>
    </main>
  );
}
