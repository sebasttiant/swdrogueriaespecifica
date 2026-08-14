import Image from "next/image";

import { APP_NAME } from "@/lib/constants/app";
import { cn } from "@/lib/utils/cn";

type BrandLogoProps = {
  className?: string;
  priority?: boolean;
};

// Logo corporativo (698x128). Por defecto se escala por altura: usá
// `className="h-8 w-auto"` u otra altura según el contexto.
//
// `unoptimized`: el build standalone (Docker) no trae `sharp`, así que el
// optimizador de next/image falla y la imagen sale rota. El .webp ya viene
// optimizado; lo servimos directo desde /public sin pasar por /_next/image.
export function BrandLogo({ className, priority = false }: BrandLogoProps) {
  return (
    <Image
      src="/logo-especifica.webp"
      alt={APP_NAME}
      width={698}
      height={128}
      priority={priority}
      unoptimized
      // En oscuro el logo recupera el fondo claro para el que fue diseñado.
      //
      // Es una placa de dos bloques opacos (verde y navy) sobre transparente:
      // contra un fondo oscuro el verde encandila y el navy se funde con la
      // pantalla, así que la marca pierde su forma y queda coja. La placa clara
      // la devuelve entera, sin retocar un solo color del logo.
      //
      // Va sobre la propia imagen, NO en un contenedor: uno de los usos lleva
      // `lg:hidden` y un wrapper dejaría una caja vacía en escritorio.
      //
      // El margen de la placa se hace con `ring` (una sombra) y no con padding:
      // el padding se descontaría del alto por `box-border` y el logo se vería
      // más chico en oscuro que en claro. La sombra no ocupa espacio, así que
      // el tamaño y el layout quedan idénticos en los dos temas.
      className={cn(
        "dark:rounded-md dark:bg-white dark:ring-4 dark:ring-white",
        className,
      )}
    />
  );
}
