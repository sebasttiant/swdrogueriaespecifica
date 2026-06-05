import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Une clases condicionales y resuelve conflictos de Tailwind (último gana).
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
