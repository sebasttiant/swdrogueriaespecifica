# Permisos de bodega sobre pendientes

Issue: #336. Branch: `fix/permisos-bodega`.
Bodega cancela cualquier pendiente, marca el estado y deja la nota, sin ganar
autoridad de facturación ni de compras.

## Specs

1. **S1** — «Todas las personas pueden cancelar, pero no cualquier pendiente, el
   pendiente de ellos. (…) Los perfiles de bodega y pendientes sí pueden
   cancelar todos.» (Daniel, reunión 2026-11-06)
2. **S2** — «Yo le habilito esa funcionalidad que ya está creada para ellos al
   perfil de bodega, y ya en ese se coloca que está agotado el producto, o la
   información que se necesite.» (acordado con Doña Marta y David en la misma
   reunión: marcar agotado y escribir la nota de qué llegó)
3. **S3** — Nadie pidió abrirle a bodega la facturación ni la entrega de
   pendientes ajenos, ni la autoridad de compras sobre faltantes. Lo no pedido
   queda cerrado y probado.
4. **S4** — El alcance que ofrece la pantalla y el que valida el servidor son el
   mismo: un botón que el servidor rechaza es peor que no tenerlo.
5. **S5** — Validación en el servidor de pruebas con David y Doña Marta antes de
   producción (acuerdo de la reunión).

## Tasks

- [x] **T1** — S1,S4 — Eje propio `canCancelAllPendings` y `cancelScopeFor` con
      dos ejes, igual que `editScopeFor`. Route: parent. Commit: pendiente.
- [x] **T2** — S2,S3 — Separar `canSetPendingManagementStatus` de
      `canOrderMissingItems`, que además autoriza pedir y descartar faltantes.
      Route: parent. Commit: pendiente.
- [x] **T3** — S1-S3 — Bodega suma las tres capacidades; las tres pantallas de
      pendientes leen la capacidad nueva. Route: parent. Commit: pendiente.
- [x] **T4** — S4 — `cancelPendingAction` valida con `cancelScopeFor`, no con
      `canManageAllPendings`. Route: parent. Commit: pendiente.
- [ ] **T5** — S1-S4 — Validación completa y PR. Route: parent.
- [ ] **T6** — S5 — Despliegue a pruebas y validación con David y Doña Marta.
      Route: operador.

## Log

- **L1** — «arregla pero lo que quiero es que vean que se les ha trabajado todo
  en mejorarlo (…) y quiero que ellos sean quien me definan el tema de los
  productos y inventario, ellos tienen que definir qué hacer.»
- **L2** — Doña Marta reportó que no podía cancelar ni el pendiente que ella
  misma anotó. Daniel lo confirmó en la reunión y pidió corregirlo.
- **L3** — Diagnóstico inicial equivocado: se leyó el repositorio principal, que
  estaba parado en la rama de septiembre (`feat/missing-management-pagination`,
  seis semanas de atraso). Ese código no tenía los ejes por acción, y por eso la
  pantalla reportada «no podía existir». El código real de `main` sí los tiene y
  explica la foto exactamente: bodega tiene `editScope: "all"` y el resto `own`,
  así que sobre una fila ajena solo queda Corregir. **No era un defecto.**
- **L4** — El trabajo abandonado de septiembre se guardó en `631b8e81` sobre su
  propia rama antes de empezar, para no mezclarlo.
- **L5** — Decisión de diseño: `canManageAllPendings` abre el alcance de TODAS
  las acciones de cliente a la vez. Colgar la cancelación de ahí le habría dado
  a bodega facturar y entregar lo ajeno, que nadie pidió y no se deshace. Se usa
  el molde que el código ya tenía en `editScopeFor`: autoridad de entrada más un
  eje propio de alcance.
- **L6** — Mismo criterio con el estado de gestión: `canOrderMissingItems`
  autoriza además pedir y descartar faltantes. Se separó
  `canSetPendingManagementStatus` y las tres pantallas de pendientes
  (`/pendientes`, `/revision-pendientes`, `/lista-de-espera`) leen la nueva. El
  uso en `pendientes/[id]/editar` NO se tocó: ahí la capacidad gatea una
  contención de pérdida de unidades, que es otra cosa.
- **L7** — RED observado: 3 fallas exactas de 131 en `permissions.test.ts`
  (`cancel` daba `own`, y las dos capacidades nuevas daban `false`). Las cuatro
  expectativas que afirman que bodega NO gana facturación, entrega, contacto ni
  compras ya pasaban en rojo, que es lo que se quería.
- **L8** — Defecto encontrado durante la implementación y corregido:
  `cancelPendingAction` validaba con `can(role, "canManageAllPendings")` mientras
  la pantalla decidía con `cancelScopeFor`. Sin esto, bodega habría visto el
  botón y el servidor le habría devuelto NOT_OWNER al tocarlo.
- **L9** — Cuatro pruebas existentes fijaban la regla anterior y se
  actualizaron con el motivo y la fecha: dos de alcance por fila
  (`pending-row-scope`) y dos de la observación
  (`pending-observation-authorization`). OPERADOR y BODEGA dejaron de compartir
  el caso de prueba porque dejaron de comportarse igual.
- **L10** — Se agregó cobertura del servidor que faltaba: tres casos que
  afirman el booleano exacto de alcance que `cancelPendingAction` le pasa al
  service para BODEGA, SUPERVISOR y OPERADOR.
- **L11** — Validación: typecheck 0, lint 0, 3135/3135 unitarias (195 archivos),
  716/718 PostgreSQL. Las dos que fallan son los `laboratory-*` de orden de filas
  (`bayer` contra `Bayer`), preexistentes en `main` y sin relación con permisos.
  PostgreSQL pendiente de registro.
