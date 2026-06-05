import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Salida standalone: imagen Docker mínima, sin node_modules completo.
  output: "standalone",
  // En monorepo, fijamos la raíz de tracing para que el standalone copie bien.
  outputFileTracingRoot: path.join(dirname, "../../"),
  reactStrictMode: true,
};

export default nextConfig;
