"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";

// --------------------------------------------------------------------------
// Volver a la pantalla anterior.
//
// Esto se usa casi siempre desde el celular, donde no hay barra lateral a la
// vista y el botón del navegador queda lejos del pulgar. Sin una salida propia,
// entrar a una pantalla anidada —corregir un pendiente, ver un producto— se
// siente como un callejón.
//
// El destino se deriva de la RUTA, no del historial. `router.back()` devuelve a
// donde el navegador venga, que puede ser otro sitio o una página que ya no
// aplica; una ruta padre siempre lleva al mismo lugar y se puede compartir.
//
// En las pantallas de primer nivel no aparece: ahí la navegación ya está a la
// vista —barra lateral en escritorio, barra inferior en celular— y un "volver"
// sería un botón de más compitiendo con ella.
// --------------------------------------------------------------------------

/** `/pendientes/abc/editar` → `/pendientes`. Null en el primer nivel. */
export function parentPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length <= 1) return null;
  return `/${segments[0]}`;
}

const SECTION_LABELS: Record<string, string> = {
  pendientes: "Pendientes",
  faltantes: "Faltantes",
  entradas: "Entradas",
  productos: "Productos",
  admin: "Usuarios",
  reportes: "Reportes",
  auditoria: "Auditoría",
};

export function BackLink() {
  const pathname = usePathname();
  const parent = parentPath(pathname);
  if (parent === null) return null;

  const section = parent.slice(1);
  const label = SECTION_LABELS[section];

  return (
    <Link
      href={parent}
      // Altura de dedo: se toca con el pulgar, muchas veces caminando.
      className="mb-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary hover:underline print:hidden"
    >
      <ArrowLeft className="size-4 shrink-0" aria-hidden />
      Volver{label ? ` a ${label}` : ""}
    </Link>
  );
}
