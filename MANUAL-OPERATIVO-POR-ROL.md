# Manual operativo por rol — TEST

**Documento preparado; capacitación y validación integrada pendientes.** Usalo en TEST con datos ficticios. No constituye aceptación ni autorización de producción.

## Ruta rápida por rol

Los roles del sistema son `OPERADOR`, `BODEGA`, `SUPERVISOR`, `ADMIN` y `SUPERADMIN`. «Vendedor» puede aparecer como campo o descripción, pero no es un rol adicional.

| Rol | Qué hacer | Límite que respetar |
| --- | --- | --- |
| OPERADOR | En `/pendientes`, registrar producto, cantidad y los datos solicitados por el formulario; pulsar **Registrar pendiente**. En `/revision-pendientes` → **Seguimiento**, revisar y operar sus pendientes: facturar, entregar o cancelar cuando corresponda. Reportar faltantes en `/faltantes`. | Opera sus propios pendientes. No accede a `/entradas` ni `/productos`; no recibe mercadería ni decide compras. |
| BODEGA | En `/revision-pendientes` → **Abastecimiento**, localizar el producto, marcar **Ya llegó** y luego **Registrar entrada**. También puede registrar entradas en `/entradas` y gestionar catálogo en `/productos`. | Lee la cola completa de pendientes, sin identidad del cliente en esa vista, pero las acciones de cliente se limitan a los propios. En `/revision-faltantes` su cola de recepción queda vacía: los faltantes de estantería son informativos y no se reciben en bodega. No pide ni descarta compras. |
| SUPERVISOR | Revisar y operar pendientes de toda la cola en **Seguimiento**. Consultar `/entradas`, `/productos` y `/revision-identidad-pendientes` para corregir identidad cuando corresponda. | Entradas es consulta, sin formulario de alta. No marca llegadas, no compra ni escribe observaciones de gerencia. No accede a Revisión de faltantes. |
| ADMIN | Operar toda la cola; actualizar seguimiento de compra y observación de gerencia. Revisar reportes de estantería, pedir y exportar desde `/revision-faltantes`. Puede recibir y registrar entradas como respaldo de BODEGA. | Gestiona usuarios de su nivel e inferiores, nunca SUPERADMIN. La gestión de contraseñas tiene restricciones adicionales. |
| SUPERADMIN | Tiene las capacidades operativas de ADMIN y puede gestionar todos los roles desde `/admin`; dispone de `/reportes` y `/auditoria`. | Usar únicamente las acciones necesarias para la tarea; este rol no autoriza por sí mismo un pase a producción. |

## Recepción, facturación y entrega: no son lo mismo

1. **Reservar:** un pendiente con cobertura aparta inventario; la reserva no descuenta stock físico. Revisá disponible y saldo antes de actuar.
2. **Recibir:** **Ya llegó** registra llegada, no carga inventario. En **Registrar entrada**, el producto proveniente de la cola queda fijo. Ingresá la cantidad real; lote, vencimiento y laboratorio de lo recibido son opcionales. Sin SKU de Orión, resolvé la identidad antes de cargar.
3. **Facturar normalmente:** revisá **Cantidad a facturar**; se propone lo facturable con stock. Se permite una parte y luego **Facturar el resto**.
4. **Excepción sin stock:** al superar lo facturable aparece una advertencia. **Cancelar** vuelve al formulario; **Confirmar facturación sin stock** registra la excepción auditada. No crea stock, no reserva ni habilita entrega por sí sola. No excedas el saldo del pedido.
5. **Entregar:** usá **Cantidad a entregar** y **Entregar** dentro del disponible mostrado. Si el servidor rechaza por estado o datos desactualizados, revisá la fila antes de reintentar; no registres un pendiente duplicado para sortearlo.

Una entrada parcial mantiene el déficit pendiente. La cola de clientes está en **Revisión de pendientes**; **Revisión de faltantes** corresponde a estantería. No confundas estado de compra, llegada física, facturación y entrega.

## Qué se ve distinto en esta versión

- **Captura de pendientes:** ya no pide presentación. El campo opcional **Vendedor** sirve para escribir quién atendió cuando la cuenta es compartida; no cambia quién es el dueño del pendiente.
- **Entradas:** lote y vencimiento son opcionales. Sin lote se registra como «Sin lote»; un lote ya registrado con otro vencimiento se rechaza.
- **Faltantes de estantería (informativos):** los reporta el vendedor y los gestiona compras. Cuando compras marca **Ya lo pedí**, el faltante queda terminado; bodega no lo recibe.
- **Revisión de pendientes:** filtro **Listos para facturar (N)**, donde N es la cantidad de pendientes. Borde amarillo cuando hay algo para facturar; borde rojo con la palabra **Agotado** cuando compras lo marcó agotado y no hay nada para facturar. Línea verde **Ya llegó a bodega** o **Ya llegó parte a bodega**. La **Observación gerencia** se ve en un recuadro celeste.
- **Depósito:** no está incluido en esta versión; queda pendiente de definir quién lo ve y lo edita.
- **Reportes:** descarga en Excel; «Descargar PDF» abre la impresión del navegador.

## Guion breve de demostración / video

**Guion preparado, no video grabado ni capacitación impartida.** Duración orientativa: 8–10 minutos; usar solo datos ficticios, sin capturar credenciales ni información personal.

| Tramo | Mostrar | Pregunta de comprobación |
| --- | --- | --- |
| 1. OPERADOR | Registrar un pendiente y revisar cobertura en Seguimiento. | ¿Qué queda reservado y qué falta conseguir? |
| 2. BODEGA | Abastecimiento → Ya llegó → entrada parcial y resto. | ¿Por qué llegada no equivale a stock cargado? |
| 3. Facturación | Facturar una parte con stock; en otro caso, mostrar advertencia sin stock y cancelar. Confirmar la excepción solo en el caso TEST previsto. | ¿Por qué facturar sin stock no permite entregar? |
| 4. SUPERVISOR / ADMIN | Contrastar alcance de pendientes, consulta de entradas y revisión de faltantes. | ¿Quién recibe, quién compra y quién puede operar una fila ajena? |
| 5. Cierre | Entregar dentro del disponible y registrar resultados en la planilla vinculada. | ¿Qué falta para aceptar TEST? |

Fecha de demostración: ______ · Responsable: ______ · Participación verificada: ______
Resultado observado: ______ · Referencia de evidencia sin datos personales: ______

## Incidencias y continuidad

Anotá paso, rol, resultado esperado/observado y referencia técnica sanitizada en [Validación manual](VALIDACION-MANUAL-pendientes-recepcion.md). No adjuntes contactos, credenciales, datos personales ni capturas a estos documentos.

Consultá el [Runbook de restauración](RUNBOOK-RESTAURACION.md) como referencia técnica, no como autorización de ejecución. **No se demostró un ensayo de restauración para este cierre TEST**; la afirmación histórica del runbook no sustituye evidencia actual. El script de restauración independiente pertenece a `feat/restore-operativo`: no se presenta como integrado aquí. Este manual no fija compromisos de soporte, recuperación ni condiciones comerciales.

## Base verificada

Lectura de código, no ejecución manual: `apps/web/lib/auth/permissions.ts`, `apps/web/lib/constants/nav.ts`, páginas de Entradas y Revisión de pendientes; formularios `pending-form.tsx`, `pending-customer-lifecycle-form.tsx`, `pending-deliver-form.tsx`, `pending-reception-queue.tsx`, `entry-form.tsx`; servicios `pending.service.ts` y `pending-reception.service.ts`.

**Aprendizajes:** ver toda la cola no autoriza modificarla; llegada no carga inventario; facturación excepcional no crea stock. El recorrido real y sus evidencias siguen pendientes de completar.
