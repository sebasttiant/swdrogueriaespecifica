# Recorrido manual — pendientes y recepción

Rama `feat/abastecimiento-en-revision-pendientes`. Sin push.

Cada paso dice **qué hacer**, **qué tiene que pasar** y **qué significa si falla**.
Ese último campo importa: un síntoma parecido puede venir de dos defectos muy
distintos, y saber cuál es evita perder una tarde.

## Preparación

```bash
docker compose up --build
```

Cuentas necesarias: una por rol — SUPERADMIN, ADMIN, SUPERVISOR, OPERADOR y
BODEGA. Elegí **un producto de catálogo con SKU**; sin código de Orión la
entrada se rechaza a propósito (regla H3) y vas a creer que el flujo está roto
cuando en realidad te está protegiendo.

Anotá el nombre del producto: lo vas a seguir por seis pantallas.

---

## 1. Pendiente con stock completo → reserva → disponible para facturar

**Hacer.** Como OPERADOR, `/pendientes` → Nuevo pendiente. Elegí un producto con
stock de sobra y pedí menos de lo que hay.

**Tiene que pasar.**
- El pendiente queda **Disponible completo** y se puede **facturar** ya.
- En `/productos`, el stock físico del lote **NO bajó**.
- En `/revision-pendientes` → Abastecimiento, **no aparece**: no hay nada que conseguir.

**Si el stock bajó** → alguien convirtió la reserva en descuento. Es el error
que hace mentir al inventario: la caja sigue en el estante hasta que se entrega.

---

## 2. Stock parcial → déficit correcto

**Hacer.** Con 5 unidades en estante, cargá un pendiente de 12.

**Tiene que pasar.**
- El pendiente queda **Disponible parcial**.
- En Abastecimiento, la fila dice **7 por conseguir** y **5 de 12 ya reservadas**.

**Si dice 2** → volvió el doble descuento: `MissingItem.quantity` ya ES el
déficit y alguien le restó otra vez lo reservado. Bodega saldría a buscar cinco
unidades de menos.

---

## 3. Sin stock → visible para BODEGA, ADMIN y SUPERADMIN

**Hacer.** Cargá un pendiente de un producto con stock 0. **No toques nada como
gerencia.** Entrá con los tres roles a `/revision-pendientes` → Abastecimiento.

**Tiene que pasar.** Los tres lo ven, con el botón **Ya llegó**.

**Este es el paso más importante del recorrido.** Si no aparece sin que gerencia
haga algo antes, volvió el candado original: la recepción atada al botón
"Pedido", y el pedido del cliente que nunca le llega a bodega.

**Extra — el punto delicado.** Como ADMIN, en Seguimiento poné el pendiente en
**cualquier** estado de compra, incluido **Agotado**. Volvé a Abastecimiento:
tiene que **seguir estando y seguir siendo recibible**. `purchaseStatus` informa
en qué anda la compra; no es una puerta.

---

## 4. Ya llegó → primera alerta, todavía sin facturar

**Hacer.** Como BODEGA, tocá **Ya llegó**.

**Tiene que pasar.**
- La fila pasa a **Llegó · sin cargar**, con **quién** la recibió y **cuándo**.
- El creador del pendiente ve en `/pendientes`: **"Llegó a la droguería · sin cargar"**.
- **Facturar sigue deshabilitado.**
- Recargá la pantalla y volvé a entrar: **el aviso sigue siendo uno solo**.

**Si ya se puede facturar** → se fundieron las dos alertas. Entre llegar y poder
vender está el registro de la entrada; sin él no hay inventario asignado y le
estarías prometiendo al cliente algo que el sistema no tiene.

**Si el aviso se duplica al recargar** → se rompió la idempotencia del outbox.

---

## 5. Entrada parcial → reduce el déficit

**Hacer.** Como BODEGA, **Registrar entrada**. El producto viene fijo. Cargá
**menos** de lo que falta (ej. 4 de 10), con lote, vencimiento y laboratorio.

**Tiene que pasar.**
- El déficit baja a **6** y la fila **sigue en la cola**.
- El pendiente queda **Disponible parcial**.
- **No** llega el aviso de "podés facturar".

**Si la fila desaparece** → bodega dejaría de buscar el resto.

---

## 6. Entrada completa → segunda alerta y habilita facturación

**Hacer.** Registrá el resto.

**Tiene que pasar.**
- La fila **sale** de Abastecimiento.
- El creador recibe **"Llegó un pedido tuyo"** y ya puede **facturar**.
- El aviso de disponibilidad llega **una sola vez**.

**Repetilo con un pendiente creado por ADMIN.** El aviso tiene que llegarle **a
ADMIN**, no a un vendedor. Gerencia también atiende el mostrador, y si los avisos
se dirigieran por rol, ese pendiente se cargaría y nadie se enteraría.

---

## 7. OPERADOR, VENDEDOR y SUPERVISOR no pueden recibir ni cargar

**Hacer.** Con cada uno, entrá a `/revision-pendientes` → Abastecimiento.

**Tiene que pasar.**
- Ven el estado de los pendientes —es su cliente el que espera— pero **no** el
  botón Ya llegó ni Registrar entrada.
- SUPERVISOR **no** ve el atajo a Revisión de faltantes.
- `/entradas` les muestra la lista pero **no** el formulario.

**Prueba real del guard.** Escribí `/entradas` a mano en la barra. Tiene que
rebotar. Esconder un botón no autoriza nada: quien decide es el servidor.

---

## 8. Ningún pendiente aparece en Revisión de faltantes

**Hacer.** Como ADMIN, `/revision-faltantes`, las cuatro pestañas.

**Tiene que pasar.**
- Ninguno de los productos que venís siguiendo aparece.
- El contador "Por pedir" **no** los cuenta.
- El export (Excel/CSV) **no** los trae.
- En el dashboard, **Faltantes de estantería** y **Pendientes por abastecer** son
  dos tarjetas, y cada número **coincide** con lo que muestra su pantalla.

**Si un pendiente aparece acá** → se perdió el filtro por origen y gerencia
vuelve a decidir sobre dos negocios en una sola lista.

---

## Lo que este recorrido NO cubre

- **Concurrencia.** Dos personas cargando a la vez está probado contra
  PostgreSQL real; a mano no es reproducible.
- **`MissingItem` sigue siendo el riel interno** de un pendiente. Funciona, pero
  la tabla se llama como el otro negocio. Es el paso 5 y no se tocó.
- **Bodega tiene dos entradas de menú**: Revisión de pendientes (clientes) y
  Revisión de faltantes (estantería). No son dos pantallas para un mismo
  pendiente, pero son dos lugares.
