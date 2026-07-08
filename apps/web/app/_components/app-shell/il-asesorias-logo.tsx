import Image from "next/image";

import { IL_ASESORIAS } from "@/lib/constants/app";

type IlAsesoriasLogoProps = {
  className?: string;
};

// Logo del proveedor tecnológico IL Asesorías (500x303). Uso institucional
// discreto (login). Se controla el tamaño renderizado por ancho vía className
// (ej. `w-32`), nunca editando el archivo.
//
// `unoptimized`: igual que BrandLogo — el build standalone (Docker) no trae
// `sharp`, así que servimos el PNG directo desde /public sin /_next/image.
export function IlAsesoriasLogo({ className }: IlAsesoriasLogoProps) {
  return (
    <Image
      src="/logo-ilasesorias.png"
      alt={IL_ASESORIAS.name}
      width={500}
      height={303}
      unoptimized
      className={className}
    />
  );
}
