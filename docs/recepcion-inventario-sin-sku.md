# Recepción de inventario sin código de Orión

El código de Orión es opcional para crear productos y capturar pedidos. También
puede faltar cuando la mercadería llega físicamente: el producto es nuevo, Orión
no responde o el código de la caja no permite identificarlo con seguridad.

La caja no debe quedar fuera del inventario por ese motivo. Tampoco debe entrar
en silencio, porque después nadie puede explicar qué unidades siguen sin
identidad externa.

## Regla operativa

Una entrada sin código de Orión se permite únicamente cuando Bodega:

1. selecciona el producto correcto;
2. confirma explícitamente que recibirá inventario sin código;
3. elige un motivo de la lista cerrada;
4. opcionalmente deja una nota breve para resolverlo después.

La confirmación no asigna, inventa ni cambia ningún código de Orión.

## Qué registra el sistema

La entrada conserva permanentemente:

- producto y código interno;
- lote, cantidad, vencimiento y laboratorio observado;
- usuario y momento de recepción;
- motivo de la excepción;
- nota operativa opcional.

La misma transacción escribe la entrada, el lote, las asignaciones y la auditoría
de la excepción. Si la auditoría no se puede guardar, tampoco entra el stock.

La nota libre no se copia al asiento de auditoría. La auditoría registra el
producto, el motivo, la confirmación y el actor; la nota queda solamente en la
entrada operativa.

## Control de descuadres

Todo producto con una recepción excepcional y sin código aparece primero en
**Revisión de identidad**. La cola muestra:

- cantidad de pedidos abiertos capturados sin identidad;
- cantidad de recepciones excepcionales;
- unidades físicas recibidas sin código de Orión.

Los productos con mercadería ya recibida se priorizan sobre los que solamente
tienen pedidos. Cuando se vincula el código correcto, el producto desaparece de
la cola automáticamente, pero las entradas y sus motivos se conservan como
historia.

## Guardas que siguen vigentes

Permitir la recepción no relaja la identidad del catálogo:

- un código de Orión no puede pertenecer a dos productos;
- recepción nunca mueve un código de un producto a otro;
- corregir o reasignar un código sigue siendo una operación explícita y auditada;
- cambiar de producto invalida la confirmación de excepción anterior;
- si el producto obtiene código mientras el formulario está abierto, la
  excepción vieja se rechaza y se pide verificar nuevamente;
- reutilizar una clave de operación con otro motivo o nota se rechaza como
  conflicto de idempotencia.

## Qué debe hacer Bodega

Si conoce el código correcto, debe vincularlo desde el enlace al producto y
registrar la entrada normalmente.

Si no puede obtenerlo sin detener la recepción, puede usar la excepción. Debe
seleccionar el motivo real; no debe escribir códigos aproximados ni crear otro
producto manual para evitar la advertencia.
