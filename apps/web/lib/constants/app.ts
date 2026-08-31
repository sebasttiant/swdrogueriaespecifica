// --------------------------------------------------------------------------
// Dos nombres distintos, y confundirlos es el error que estas constantes
// existen para evitar:
//
//   BUSINESS_NAME  la droguería. El establecimiento, la razón comercial, lo
//                  que dice el logo de la puerta.
//   PRODUCT_NAME   el software. Una plataforma administrativa que va a sumar
//                  módulos, así que su nombre no puede quedar atado a los tres
//                  que tiene hoy.
//
// El logo de la marca describe al NEGOCIO. El título del navegador y la
// bienvenida nombran al SOFTWARE. Escribir el nombre a mano en cada pantalla
// es como aparecen "Especifica Go", "Específica Go" y "Droguería Específica
// App" conviviendo en la misma aplicación.
// --------------------------------------------------------------------------

/** El software. Se escribe así: acento en la "i", GO en mayúsculas. */
export const PRODUCT_NAME = "Específica GO";

/** El negocio: la droguería. No se reemplaza por el nombre del software. */
export const BUSINESS_NAME = "Droguería Específica";

export const APP_NAME = PRODUCT_NAME;
export const APP_SHORT_NAME = "Específica";
export const APP_DESCRIPTION =
  "Plataforma administrativa para operar la droguería desde el celular.";

/** La bienvenida del login. Una sola definición, para poder probarla. */
export const LOGIN_TAGLINE = `Accede a ${PRODUCT_NAME} para administrar tu operación.`;

// Atribución institucional del proveedor tecnológico (IL Asesorías). Se muestra
// de forma discreta: bloque en el login y footer sobrio en el layout interno.
// No es la marca principal de la app (esa es Específica GO).
export const IL_ASESORIAS = {
  name: "IL Asesorías",
  url: "https://www.ilasesorias.com/",
  developedBy: "Sistema desarrollado por IL Asesorías",
  tic: "Dirección TIC — Sebastián Amaya",
  copyright: "© 2026 IL Asesorías. Todos los derechos reservados.",
} as const;
