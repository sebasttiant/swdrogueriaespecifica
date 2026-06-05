# feature: auth

Lógica de autenticación por feature. **Fase 1: solo estructura.**

La separación Edge-safe / Node-only vive en `lib/auth/`:

- `lib/auth/config.edge.ts` — edge-safe (sin Prisma), usado por `middleware.ts`.
- `lib/auth/index.node.ts` — Node-only (placeholder), futuro punto único de sesión.
- `lib/auth/session.ts` — tipos compartidos.

En Fase 2/3 se decide el mecanismo (Auth.js v5 estable, NextAuth v4, o auth propia
con cookie httpOnly) y se implementa acá la UI/servicios del login.
