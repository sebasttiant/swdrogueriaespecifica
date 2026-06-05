# Droguería Específica — Software web

Base técnica del software de gestión para **Droguería Específica**.
100% web, responsive, **mobile-first** (el gerente opera desde el celular),
dockerizado desde el inicio y **auditable**.

> **Estado: Fase 1 (cimientos).** Estructura, stack, Docker, CI/CD, base visual
> y base de auditoría. La lógica de negocio se implementa en fases siguientes.

---

## Stack (versiones fijadas, sin rangos)

| Capa        | Tecnología            | Versión        |
| ----------- | --------------------- | -------------- |
| Runtime     | Node.js               | 24.16.0        |
| Package mgr | pnpm (vía Corepack)   | 11.5.2         |
| Framework   | Next.js (App Router)  | 16.2.7         |
| UI          | React / react-dom     | 19.2.7         |
| Estilos     | Tailwind CSS          | 4.3.0          |
| Lenguaje    | TypeScript (strict)   | 6.0.3          |
| ORM         | Prisma + @prisma/client | 7.8.0        |
| Driver DB   | @prisma/adapter-pg    | 7.8.0          |
| Base datos  | PostgreSQL (Docker)   | 18.4-alpine    |
| Validación  | Zod                   | 4.4.3          |
| Gráficas    | Recharts              | 3.8.1          |
| App runtime | Debian 13 "trixie"    | node:24.16.0-trixie |

> **Auth:** en Fase 1 **no** se instala ninguna dependencia de auth. Solo se deja
> la estructura Edge-safe / Node-only lista (ver _Estrategia de Auth_).

---

## Requisitos

- Node.js 24.16.0 (ver `.nvmrc`).
- Corepack (incluido en Node) para activar pnpm 11.5.2.
- Docker + Docker Compose (para levantar la base y la app).

### Bootstrap del toolchain (pnpm 11.5.2) — IMPORTANTE

Este proyecto **exige pnpm 11.5.2** (campo `packageManager`). Hay un detalle de
entorno a tener en cuenta:

> Si en tu máquina existe un pnpm global "standalone" más viejo que 11.5.2, ese
> pnpm intenta auto-provisionar 11.5.2 usando tu config **global** (p. ej.
> `minimumReleaseAge`) y puede quedar **bloqueado** antes de aplicar el `.npmrc`
> del proyecto. La solución limpia es usar el pnpm de **Corepack** directo.

**Solución reproducible (no toca ninguna config global):**

```bash
# Opción A — un solo comando (recomendado): activa pnpm 11.5.2 + instala
./scripts/bootstrap.sh

# Opción B — manual:
corepack enable
corepack prepare pnpm@11.5.2 --activate
export PATH="$(dirname "$(command -v corepack)"):$PATH"   # prioriza el pnpm de Corepack
pnpm -v   # debe imprimir 11.5.2
pnpm install
```

Para que persista entre sesiones, agregá a tu `~/.bashrc` / `~/.zshrc`:

```bash
export PATH="$(dirname "$(command -v corepack)"):$PATH"
```

Verificar el toolchain en cualquier momento:

```bash
pnpm check:toolchain   # o: node scripts/check-toolchain.mjs
```

---

## Puesta en marcha (local, sin Docker)

```bash
./scripts/bootstrap.sh     # activa pnpm 11.5.2 + instala (ver "Bootstrap del toolchain")
cp env.example .env        # completá los valores (ver nota de .env más abajo)
pnpm dev                   # http://localhost:3000  ->  redirige a /dashboard
```

> Si ya tenés pnpm 11.5.2 activo, podés usar `pnpm install` directamente en vez
> del bootstrap.

> **Nota sobre `.env`:** el archivo de ejemplo se llama **`env.example`** (sin
> punto inicial) porque la política de seguridad del entorno bloquea crear
> archivos `.env*`. Copialo a `.env` con `cp env.example .env`.

---

## Puesta en marcha (Docker — recomendado)

```bash
cp env.example .env
docker compose up --build
```

Orden garantizado por healthchecks:
`postgres (healthy)` → `migrate (corre y termina)` → `web (arranca)`.

- Web: http://localhost:3000
- Healthcheck: http://localhost:3000/api/health

Validar la configuración del compose sin levantar nada:

```bash
docker compose config
```

> **Fase 1 incluye la migración inicial** (`apps/web/prisma/migrations/…_init`)
> con las 6 tablas, enums e índices. El servicio `migrate` corre
> `prisma migrate deploy` y **aplica esas migraciones ANTES** de que arranque la
> web, así la base queda con tablas desde el primer `up`.

---

## Scripts

Todos con **pnpm** (nunca npm):

| Script              | Qué hace                                  |
| ------------------- | ----------------------------------------- |
| `pnpm dev`          | Next en modo desarrollo                   |
| `pnpm build`        | `prisma generate` + `next build`          |
| `pnpm start`        | Sirve el build de producción              |
| `pnpm lint`         | ESLint (flat config + reglas de Next)     |
| `pnpm typecheck`    | `prisma generate` + `tsc --noEmit`        |
| `pnpm test`         | Vitest (smoke tests)                      |
| `pnpm db:generate`  | Genera el cliente Prisma                  |
| `pnpm db:migrate`   | Crea/aplica migración en dev              |
| `pnpm db:deploy`    | Aplica migraciones (producción)           |
| `pnpm db:seed`      | Carga datos de ejemplo                    |
| `pnpm docker:build` | Build de la imagen web                    |

---

## Estructura

```
apps/web/
  app/
    (auth)/login/            # login placeholder (logo + form deshabilitado)
    (dashboard)/             # dashboard + módulos (productos, pendientes, ...)
    api/health/              # healthcheck (no toca la DB)
    _components/
      app-shell/             # Sidebar, Topbar, MobileNav, PageHeader, BrandLogo
      ui/                    # Button, Card, Badge, StatusPill, KpiCard, QuickAction
  features/                  # lógica por feature (Fase 1: estructura)
    auth/ productos/ pendientes/ faltantes/ entradas/ reportes/ auditoria/
  lib/
    auth/                    # split Edge-safe (config.edge) / Node-only (index.node)
    db/                      # cliente Prisma singleton (adapter-pg)
    validations/ constants/ utils/
  server/
    actions/ services/ repositories/   # services/audit.service.ts (auditoría)
  prisma/
    schema.prisma            # User, Product, Pending, MissingItem, InventoryEntry, AuditLog
    seed.ts
  middleware.ts              # Edge-safe (sin Prisma); placeholder de protección
  Dockerfile                 # multi-stage (base/deps/builder/migrate/runner)
docker-compose.yml
.github/workflows/           # ci-pr, ci-main, codeql, gitleaks
```

---

## Mobile-first

El celular manda. En celular: tarjetas y listas (no tablas), botones grandes
(≥44px), texto base 17px, barra inferior de navegación con las 4 acciones
principales. En desktop: sidebar lateral. Los estados se comunican con **color +
texto** (nunca solo color) para accesibilidad.

---

## Auditoría

El sistema es auditable desde Fase 1. Cada acción importante debe poder responder:
**quién · cuándo · qué · sobre qué registro · qué cambió · desde dónde · si fue
exitoso o fallido.**

Piezas ya disponibles:

- **Modelo** `AuditLog` (`prisma/schema.prisma`): usuario, acción, módulo, entidad,
  entityId, resultado (SUCCESS/FAILURE), IP, user agent, canal, `before`/`after` (JSON), fecha.
- **Servicio** `recordAudit(...)` (`server/services/audit.service.ts`): reutilizable,
  no rompe la operación si el log falla.
- **Acciones/módulos canónicos** (`lib/constants/audit.ts`): fuente de verdad tipada.
- **Tipos de consulta** (`features/auditoria/types.ts`): filtros para la pantalla de Fase 2.

En Fase 2 se construye la pantalla de consulta (filtros: fecha, usuario, acción,
módulo, entidad, resultado) y se cablea `recordAudit` en cada acción de negocio.

---

## Estrategia de Auth (decisión de Fase 1)

Fase 1 **no implementa login** ni instala dependencias de auth (evita beta o
desalineadas). Solo deja la arquitectura limpia:

- `lib/auth/config.edge.ts` — **Edge-safe**: sin Prisma, sin Node-only. Lo usa `middleware.ts`.
- `lib/auth/index.node.ts` — **Node-only** (placeholder): futuro punto único de sesión.
- `lib/auth/session.ts` — tipos compartidos.

En Fase 2/3 se elige el mecanismo (Auth.js v5 si está estable, NextAuth v4 si se
necesita estabilidad inmediata, o auth propia con cookie httpOnly) y se implementa.

> ⚠️ **Importante para Fase 2 — protección de rutas.** En Fase 1 el dashboard y
> los módulos quedan **públicos** (no hay login). Esto se acepta **solo como
> Fase 1**. La Fase 2 **debe** proteger todas las rutas privadas: `middleware.ts`
> (hoy placeholder edge-safe) tiene que exigir cookie de sesión válida y redirigir
> a `/login` cuando falte. Nota: Next 16 deprecó `middleware.ts` a favor de
> `proxy.ts` — la migración a `proxy.ts` se hace al implementar la protección real.

---

## Seguridad

- Secrets obligatorios con **fail-fast** (`lib/env.ts`, validación Zod perezosa).
- `middleware.ts` **no** usa Prisma ni nada Node-only (Edge-safe).
- `.env` ignorado por git; el ejemplo es `env.example` (sin secretos reales).
- CI: **Gitleaks** (secret scan) + **CodeQL** (análisis estático).

---

## Notas de entorno (para el equipo)

- **`minimumReleaseAge`**: el `.npmrc` del proyecto lo fija en `0` porque el stack
  usa versiones recién publicadas. Mitigación: versiones exactas + lockfile.
  Recomendado subirlo (p. ej. a 1 día) cuando el stack madure.
- **pnpm**: si en tu máquina hay un pnpm global más viejo que 11.5.2, su
  auto-provisión puede quedar bloqueada por `minimumReleaseAge`. Usá
  `./scripts/bootstrap.sh` (o el fix de PATH de la sección _Bootstrap del
  toolchain_) y verificá con `pnpm check:toolchain`.
