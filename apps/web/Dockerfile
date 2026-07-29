# ==========================================================================
# Droguería Específica — Dockerfile multi-stage (Fase 1)
#
# Runtime de la app: Debian 13 "trixie" (NO Alpine para Next.js).
# Postgres usa Alpine en docker-compose (patrón validado).
#
# Stages:
#   base     -> node trixie + pnpm 11.10.0 (Corepack)
#   deps     -> instala dependencias (frozen lockfile)
#   builder  -> prisma generate + next build (standalone)
#   migrate  -> aplica migraciones (corre y termina; usado por compose)
#   seed     -> carga datos iniciales (corre y termina; usado por compose)
#   runner   -> imagen final mínima, usuario no-root
# ==========================================================================

# ---------- base ----------
FROM node:24.18.0-trixie AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
# Manifiestos + schema de Prisma (el postinstall corre `prisma generate` y los
# build scripts del allowlist —incluido @prisma/engines— bajan el schema engine
# que Migrate necesita, en BUILD como root; así Migrate corre sin red ni write).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/web/prisma.config.ts ./apps/web/prisma.config.ts
COPY apps/web/prisma ./apps/web/prisma
# install tolera builds ignorados (exit 0); luego `rebuild` ejecuta los build
# scripts del allowlist (incl. @prisma/engines -> schema engine para Migrate).
RUN pnpm install --frozen-lockfile --config.strict-dep-builds=false \
 && pnpm rebuild

# ---------- builder ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
# build = `prisma generate && next build` (ver apps/web/package.json)
RUN pnpm --filter @drogueria/web build

# ---------- migrate ----------
# Aplica migraciones antes de levantar la web. Sin secretos en build:
# DATABASE_URL se inyecta en runtime (docker-compose).
FROM deps AS migrate
# deps ya tiene prisma.config.ts, el schema, las migraciones y el schema engine.
# Ejecutamos el shim de Prisma (node_modules/.bin/prisma) directo vía su shebang
# (sin pnpm) para evitar el "deps status check" de runtime (re-install) y las
# descargas de corepack.
WORKDIR /app/apps/web
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# ---------- seed ----------
# Ejecuta el seed después de las migraciones. Usa builder porque seed.ts importa
# código de la app y el Prisma Client generado durante el build.
FROM builder AS seed
WORKDIR /app/apps/web
ENV PATH="/app/apps/web/node_modules/.bin:/app/node_modules/.bin:$PATH"
USER node
CMD ["node_modules/.bin/prisma", "db", "seed"]

# ---------- runner ----------
FROM node:24.18.0-trixie AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Salida standalone (incluye server.js + node_modules mínimos).
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3000

# DATABASE_URL es validado por la app (fail-fast) en runtime, no en build.
CMD ["node", "apps/web/server.js"]
