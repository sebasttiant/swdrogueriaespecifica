import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { APP_DESCRIPTION, APP_NAME } from "@/lib/constants/app";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b66c3",
  // Required so env(safe-area-inset-*) resolves to real values on notched /
  // home-indicator devices. Without it those insets are always 0 and the fixed
  // bottom nav collides with the iOS/Android browser toolbar.
  viewportFit: "cover",
};

// Corre ANTES del primer pintado, de forma bloqueante. Sin esto, quien tiene
// el tema oscuro guardado vería un fogonazo blanco en cada carga, y quien
// eligió texto grande vería la página saltar de tamaño: el HTML del servidor
// no sabe qué eligió este navegador.
//
// El tema por defecto es CLARO, no el del sistema operativo. Es una app de
// mostrador: tiene que verse siempre igual al abrirla, sin depender de cómo
// tenga configurado el celular o la computadora cada persona. El modo oscuro
// es una elección explícita desde el botón de la topbar, y esa elección sí se
// recuerda en este navegador.
//
// Para el tamaño: solo se aplica si el valor guardado es uno de los válidos.
// Va en texto plano (no como módulo) justamente para ejecutarse antes de pintar.
const PREFS_INIT_SCRIPT = `(function(){try{var r=document.documentElement;var s=localStorage.getItem("theme");var t=(s==="dark"||s==="light")?s:"light";r.dataset.theme=t;r.style.colorScheme=t;var z=localStorage.getItem("textSize");if(z==="grande"||z==="extra"){r.dataset.textSize=z}}catch(e){}})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: el script de arriba escribe `data-theme` en el
    // <html> antes de que React hidrate, así que el atributo difiere del HTML
    // servido a propósito. Solo silencia este elemento, no los hijos.
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREFS_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
