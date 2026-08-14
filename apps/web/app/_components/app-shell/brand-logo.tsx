import Image from "next/image";

import { APP_NAME } from "@/lib/constants/app";

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
      className={className}
    />
  );
}
