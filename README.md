# Droguería Específica — Software web

Base técnica del software de gestión para **Droguería Específica**.
100% web, responsive, **mobile-first** (el gerente opera desde el celular),
dockerizado desde el inicio y **auditable**.

> **Estado: Fase 2 en progreso.** Sobre los cimientos de Fase 1 ya hay
> **autenticación real** (JWT stateless en cookie httpOnly, roles, auditoría de
> login) y **catálogo de productos con lotes y control de vencimientos**
> (semáforo derivado por fecha). Pendientes/faltantes, el loop de entradas y
> reportes/líderes quedan para fases siguientes.

---

## Stack

> Dependencias controladas por lockfile; las versiones efectivas quedan fijadas
> en `pnpm-lock.yaml`.

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
| Auth (JWT)  | jose                  | 6.2.3          |
| Hash passwd | @node-rs/argon2       | 2.0.2          |
| App runtime | Debian 13 "trixie"    | node:24.16.0-trixie |

> **Auth (Fase 2):** sesión **JWT stateless** en cookie httpOnly — `jose` (firma
> Edge-safe, verificable en el middleware sin tocar la DB) + `@node-rs/argon2`
> (hash de contraseñas, binario precompilado). Ver _Estrategia de Auth_.

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
pnpm dev                   # http://localhost:3000  ->  /login (rutas privadas protegidas)
```

> Si ya tenés pnpm 11.5.2 activo, podés usar `pnpm install` directamente en vez
> del bootstrap.

> **Nota sobre `.env`:** el archivo de ejemplo se llama **`env.example`** (sin
> punto inicial) porque la política de seguridad del entorno bloquea crear
> archivos `.env*`. Copialo a `.env` con `cp env.example .env`. Recordá setear
> `AUTH_SECRET` (≥32 chars: `openssl rand -base64 32`), obligatorio (fail-fast).

### Acceso (dev)

Las rutas privadas exigen sesión. Sembrá el usuario admin y entrá con él:

```bash
pnpm db:seed   # crea admin@drogueriaespecifica.com (rol ADMIN)
```

La contraseña sale de `SEED_ADMIN_PASSWORD` (o el fallback de dev en `seed.ts`).
**Nunca usar el fallback en producción.**

---

## Puesta en marcha (Docker — recomendado)

```bash
cp env.example .env
docker compose up -d --build --force-recreate
```

Orden garantizado por healthchecks:
`postgres (healthy)` → `migrate (corre y termina)` → `seed (corre y termina)` → `web (arranca)`.

- Web: http://localhost:3000
- Healthcheck: http://localhost:3000/api/health

Validar la configuración del compose sin levantar nada:

```bash
docker compose config
```

> **Migraciones.** El servicio `migrate` corre `prisma migrate deploy` y aplica
> **todas** las migraciones ANTES de que arranque la web. Hoy: `init` (6 tablas,
> enums e índices), `add_product_batches` (lotes/vencimientos) y
> `add_quantity_check` (CHECK `quantity >= 0`).
>
> **Seed.** El servicio `seed` corre después de `migrate` y antes de `web`, así el
> usuario demo `admin@drogueriaespecifica.com` existe al abrir la app. La
> contraseña sale de `SEED_ADMIN_PASSWORD` o del fallback de desarrollo.
>
> ⚠️ **Antes de aplicar `add_quantity_check` en una base con datos reales**,
> validá que no existan lotes con cantidad negativa — PostgreSQL **rechaza** el
> CHECK si ya hay filas inválidas:
>
> ```sql
> SELECT count(*) FROM product_batches WHERE quantity < 0;  -- debe dar 0
> ```

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
    (auth)/login/            # login real (form + server action)
    (dashboard)/             # dashboard + módulos; productos: listado + detalle [id]
    api/health/              # healthcheck (no toca la DB)
    _components/
      app-shell/             # Sidebar, Topbar (logout), MobileNav, PageHeader, BrandLogo
      ui/                    # Button, Card, Badge, StatusPill, KpiCard, QuickAction
  features/                  # lógica por feature (UI + Zod por dominio)
    auth/ productos/ pendientes/ faltantes/ entradas/ reportes/ auditoria/
  lib/
    auth/                    # Edge-safe (config.edge, jwt.edge) + Node-only (index.node, require-role, password)
    inventory/               # helpers puros: semáforo de vencimiento / stock vendible
    db/                      # cliente Prisma singleton (adapter-pg)
    pagination.ts            # paginación cursor-based compartida
    constants/ utils/
  server/                    # action -> service -> repository (por dominio)
    actions/ services/ repositories/   # auth.* , product.* , product-batch.* , audit.service
  prisma/
    schema.prisma            # User, Product, ProductBatch, Pending, MissingItem, InventoryEntry, AuditLog
    migrations/ seed.ts
  middleware.ts              # Edge-safe: protege rutas privadas (verifica JWT con jose)
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

`recordAudit` ya está cableado en login/logout y en el alta de productos
(`PRODUCT_CREATE`). Falta la **pantalla de consulta** (filtros: fecha, usuario,
acción, módulo, entidad, resultado) y cablearlo en el resto de acciones de negocio,
que llegan en fases siguientes.

---

## Estrategia de Auth (Fase 2)

Sesión **JWT stateless** en cookie httpOnly. Elegida por escala (~300 usuarios
concurrentes): el middleware verifica la firma en el Edge **sin consultar la DB**.

- `lib/auth/config.edge.ts` / `lib/auth/jwt.edge.ts` — **Edge-safe**: firma y
  verificación con `jose` (Web Crypto). Los usa `middleware.ts`. Sin Prisma.
- `lib/auth/index.node.ts` — **Node-only**: `getCurrentSession()` (lee la cookie).
- `lib/auth/require-role.ts` — guards `requireSession` / `requireRole`; `hasRole` puro.
- `lib/auth/password.ts` — hash/verify con `@node-rs/argon2`.
- `lib/auth/session.ts` — tipos compartidos.

Roles: `ADMIN`, `LIDER`, `OPERADOR`. Las **mutaciones** (p. ej. alta de productos)
exigen `ADMIN`/`LIDER`; la **lectura** es para cualquier sesión válida. El
`middleware.ts` protege todas las rutas privadas y redirige a `/login` sin sesión.
Login/logout quedan auditados (`auth.login` / `auth.login.failed` / `auth.logout`).

> El JWT lleva solo `sub`, `role`, `name`/`email`; expiración corta (2h) sin
> refresh en esta fase. Revocación instantánea (sesiones en DB / blacklist) queda
> en roadmap si aparece el requisito. Requiere `AUTH_SECRET` (≥32 chars, fail-fast).

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
