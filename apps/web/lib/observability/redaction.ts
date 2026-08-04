import { createHash } from "node:crypto";

// --------------------------------------------------------------------------
// Redacción para logs de diagnóstico.
//
// Un log de incidente se lee, se copia a un chat de soporte y se guarda en el
// VPS sin cifrar. Todo lo que entra ahí hay que asumirlo expuesto. Por eso el
// diagnóstico se hace con IDs internos, hashes y máscaras — nunca con el dato.
//
// LO QUE NUNCA SE LOGUEA, sin excepción: nombre del cliente, dirección, nota,
// teléfono completo, tokens, cookies, headers de autorización, contraseñas,
// hashes de contraseña, montos, y el FormData crudo.
//
// Estas funciones son puras a propósito: la regla de privacidad se puede probar
// sin levantar un servidor.
// --------------------------------------------------------------------------

/**
 * Identidad estable de un correo, sin el correo.
 *
 * Permite responder "¿es siempre el mismo usuario?" y "¿le pasa a más de uno?"
 * sin escribir una dirección real en el log. El mismo correo da siempre el mismo
 * hash, así que se puede agrupar y comparar entre eventos.
 *
 * Se normaliza (trim + minúsculas) ANTES de hashear: si no, `Daniel@…` y
 * `daniel@…` darían hashes distintos y parecerían dos personas.
 *
 * 16 hex (64 bits) alcanza de sobra para distinguir usuarios en un log y es más
 * corto de leer que el hash completo.
 *
 * Tolera ausencia a propósito: esto se llama desde el camino de logging, y un
 * `undefined` inesperado no puede tirar abajo el registro de un pendiente.
 */
export function hashEmail(email: string | null | undefined): string {
  if (typeof email !== "string") return "anon";
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) return "anon";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Teléfono enmascarado: solo los últimos 4 dígitos.
 *
 * Sirve para confirmar con el operador que estamos mirando SU intento ("el que
 * termina en 5273") sin que el número del cliente quede escrito en el log.
 *
 * Un valor demasiado corto para enmascarar se reporta como `***` entero: dejar
 * pasar "3016" porque "son solo 4 dígitos" sería filtrar el número completo de
 * un teléfono corto.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "***";
  return `***${digits.slice(-4)}`;
}

/**
 * Presencia y tamaño de un texto libre, sin el texto.
 *
 * Un campo como la nota puede contener datos del cliente o información
 * comercial. Para diagnosticar alcanza con saber si venía y cuán largo era —
 * por ejemplo, para descartar que el problema fuera un texto desmedido.
 */
export function describeText(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return "empty";
  return `len:${value.length}`;
}
