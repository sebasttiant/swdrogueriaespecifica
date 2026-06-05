import { redirect } from "next/navigation";

// Entrada raíz: en Fase 1 llevamos directo al dashboard.
// En Fase 2, el middleware redirige a /login si no hay sesión.
export default function Home() {
  redirect("/dashboard");
}
