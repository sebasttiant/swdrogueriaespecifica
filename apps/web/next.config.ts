import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// La identidad de ESTE build. `deploy.sh` la pasa como ARG y el Dockerfile la
// deja en `NEXT_PUBLIC_APP_VERSION` ANTES de compilar, así que queda incrustada
// en el bundle del cliente: una pestaña vieja sigue diciendo la suya aunque el
// servidor ya sea otro. Esa diferencia es justamente la que detecta el desfase.
//
// `unknown` en desarrollo, donde no hay despliegue del que desfasarse.
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

const nextConfig: NextConfig = {
  // Next etiqueta con esto los pedidos de assets y de Server Actions. Con el
  // SHA del commit, un pedido de una pestaña vieja queda identificado como tal
  // en vez de mezclarse con los del build actual.
  deploymentId: APP_VERSION,
  // Salida standalone: imagen Docker mínima, sin node_modules completo.
  output: "standalone",
  // En monorepo, fijamos la raíz de tracing para que el standalone copie bien.
  outputFileTracingRoot: path.join(dirname, "../../"),
  reactStrictMode: true,
};

export default nextConfig;
