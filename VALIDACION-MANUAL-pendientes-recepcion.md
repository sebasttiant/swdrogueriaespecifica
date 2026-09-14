# Validación manual y acta borrador — cierre TEST

**Validación integrada manual no completada.** Este documento prepara el recorrido y la recepción de resultados; no declara entrega aceptada ni habilita producción. Instrucciones por rol y guion: [Manual operativo](MANUAL-OPERATIVO-POR-ROL.md).

## Evidencia disponible: no mezclar alcances

| Evidencia comunicada para este cierre | Qué acredita | Qué no acredita |
| --- | --- | --- |
| Deploy TEST `50eeaadd`: logs aportados por el usuario con preflights y migraciones exitosos, servicios saludables | Resultado técnico del despliegue TEST informado | Recorrido integrado, capacitación o aceptación funcional |
| Pruebas focalizadas informadas por Pi (cifra no verificada) | Validación automatizada informada por otro ejecutor | Operación manual por rol ni equivalencia con todas las suites |
| Suite unitaria completa (2851 pruebas, incluye el ajuste «Ya llegó») y PostgreSQL descartable (591 pruebas, antes del ajuste visual, que no toca la base), ejecutadas por Claude | Resultado automatizado sobre la revisión del cierre | Validación manual integrada ni aceptación del cliente |

Los resultados anteriores se conservan como antecedentes suministrados para el cierre; no se ejecutaron ni se inspeccionaron sus logs en esta tarea documental. No sumar los conteos como si fueran casos independientes ni asumir que prueban todos la misma revisión desplegada.

| Unidad | Estado de cierre |
| --- | --- |
| U2 — depósito | Implementado (PR #285): lo ven y editan SUPERADMIN, ADMIN y BODEGA; OPERADOR y SUPERVISOR no. Se prueba con el caso 9 |
| U6 | Parcial; falta completar y registrar el recorrido integrado |
| U7 | Documentos preparados solamente; video, capacitación y aceptación no acreditados |

## Preparación y registro

Usar únicamente TEST ya disponible y cuentas habilitadas de SUPERADMIN, ADMIN, SUPERVISOR, OPERADOR y BODEGA. No iniciar despliegues desde esta guía. Elegir productos de prueba con SKU de Orión y cantidades controladas; evitar otras reservas que alteren los ejemplos. No usar datos personales reales.

Fecha: ______ · Revisión efectivamente probada: ______ · Entorno TEST confirmado por: ______
Identificadores técnicos de casos/productos ficticios: ______

Cada fila es una prueba **pendiente**, no un resultado observado. Completar observado (pasa/falla/no ejecutado y detalle), referencia sanitizada de evidencia y verificador; no incluir nombres personales, contactos, credenciales ni capturas. Identificar verificadores por rol o referencia interna no personal.

| Caso / acción | Resultado esperado | Observado | Evidencia | Verificador |
| --- | --- | --- | --- | --- |
| 1. OPERADOR: crear pendiente con stock suficiente; revisar Seguimiento y Abastecimiento | Disponible completo; cantidad facturable con stock. Stock físico no baja por reservar. No necesita abastecimiento. | Pendiente | ______ | ______ |
| 2. Con 5 disponibles, solicitar 12 | Disponible parcial; Abastecimiento muestra 7 por conseguir y 5 de 12 reservadas, no 2 por conseguir. | Pendiente | ______ | ______ |
| 3. Crear sin stock, sin intervención previa de gerencia; revisar como BODEGA, ADMIN y SUPERADMIN | Visible en Abastecimiento y recibible con **Ya llegó** sin exigir estado de compra Pedido. | Pendiente | ______ | ______ |
| 3b. ADMIN cambia el estado de compra, incluido Agotado | La necesidad física sigue visible y recibible mientras exista déficit. El estado de compra no bloquea recepción. | Pendiente | ______ | ______ |
| 4. BODEGA marca **Ya llegó**; creador consulta Pendientes y recarga | El pendiente muestra en verde «Ya llegó a bodega»; el aviso de llegada persiste sin duplicarse. No crea stock ni disponibilidad normal para facturar. El botón de facturación puede ofrecer la excepción del caso 4b. | Pendiente | ______ | ______ |
| 4b. Caso separado sin stock: intentar facturar; cancelar advertencia y luego confirmar explícitamente | Cancelar no factura; **Confirmar facturación sin stock** registra cantidad y auditoría. No crea stock ni reservas ni habilita entrega sin cobertura real. | Pendiente | ______ | ______ |
| 4c. Intentar superar saldo facturable del pedido o usar formulario desactualizado tras otra facturación | Rechazo sin duplicación ni sobre-facturación. Revisar el estado actualizado antes de reintentar. | Pendiente | ______ | ______ |
| 5. BODEGA: Registrar entrada, 4 de un déficit de 10, en caso sin otras reservas | Producto fijo desde la cola; déficit baja a 6 y sigue visible; disponibilidad parcial. No confundir disponibilidad parcial con aviso de pedido completo. | Pendiente | ______ | ______ |
| 6. Registrar las 6 restantes, sin facturación anticipada en este caso | Sale de Abastecimiento; disponibilidad completa y aviso al creador, una sola vez. Repetir creando como ADMIN: el destinatario es ADMIN, no un rol vendedor genérico. | Pendiente | ______ | ______ |
| 6b. Facturar una parte con stock y luego el resto; entregar dentro del disponible | Cantidades y saldos coherentes; no excede pedido ni cobertura real de entrega. Recargar y comprobar que no se duplicó el movimiento. | Pendiente | ______ | ______ |
| 7. OPERADOR y SUPERVISOR consultan Abastecimiento | Sin **Ya llegó** ni **Registrar entrada**. No tienen acceso a Revisión de faltantes. | Pendiente | ______ | ______ |
| 7b. Acceso directo a `/entradas` por rol | OPERADOR: acceso denegado/redirigido, no lista. SUPERVISOR: lista, sin alta. BODEGA/ADMIN/SUPERADMIN: lista y formulario. Intentos no autorizados de alta deben rechazarse en servidor. | Pendiente | ______ | ______ |
| 7c. Comparar pendientes propios y ajenos en Seguimiento | OPERADOR: propios. SUPERVISOR/ADMIN/SUPERADMIN: toda la cola y operación. BODEGA: lectura global sin identidad del cliente; acciones de cliente solo sobre propios. | Pendiente | ______ | ______ |
| 8. ADMIN: revisar pestañas, contador Por pedir y export de `/revision-faltantes` | Los registros originados en pendientes de clientes no aparecen ni se cuentan/exportan como faltantes de estantería. Un mismo producto podría tener un faltante independiente: contrastar origen, no solo nombre. | Pendiente | ______ | ______ |
| 8b. Dashboard frente a colas, con iguales filtros y alcance | Faltantes de estantería y pendientes por abastecer se distinguen. Contrastar contadores con el conjunto correspondiente, no solo la primera página. | Pendiente | ______ | ______ |
| 9. Depósito (U2): ADMIN o BODEGA escribe «N3» en **Depósito** de un pendiente abierto (vista detallada) y guarda; luego lo borra dejándolo vacío. Consultar el mismo pendiente como OPERADOR y SUPERVISOR | ADMIN, SUPERADMIN y BODEGA ven «Depósito: N3»; guardar vacío lo borra; el campo no admite más de 80 caracteres; un pendiente cerrado lo muestra sin permitir cambiarlo. OPERADOR y SUPERVISOR no ven el campo ni el valor en ninguna vista. La auditoría registra «Depósito de compra actualizado» con el valor anterior y el nuevo. | Pendiente | ______ | ______ |
| 10. OPERADOR: capturar un pendiente de producto manual, con y sin el campo **Vendedor**; editar un pendiente antiguo que tenía presentación | La captura no pide presentación. El vendedor escrito se ve junto a quien anotó; vacío no muestra nada. El pendiente antiguo abre y guarda sin perder su presentación. | Pendiente | ______ | ______ |
| 11. BODEGA: registrar una entrada sin lote ni vencimiento; luego otra del mismo lote real con otra fecha | La primera se guarda («Sin lote» / «Sin vencimiento») y el stock queda vendible. La segunda se rechaza con mensaje claro, sin cambios. | Pendiente | ______ | ______ |
| 12. OPERADOR reporta un faltante de estantería; ADMIN marca **Ya lo pedí** | Queda en «Ya pedidos» y deja de contar como abierto. No aparece en la cola de recepción de bodega y una entrada del mismo producto no lo consume. | Pendiente | ______ | ______ |
| 13. Revisión de pendientes: filtro **Listos para facturar (N)**, bordes y textos | N cuenta pendientes, no unidades, y coincide con la lista filtrada. Un parcial muestra «Listo para facturar: X de Y». Borde amarillo con algo para facturar; borde rojo acompañado de **Agotado**. Línea verde «Ya llegó a bodega». **Observación gerencia** en recuadro celeste. En celular los textos se parten sin desbordar. | Pendiente | ______ | ______ |
| 14. ADMIN/SUPERADMIN: cambiar la contraseña de otro usuario, archivar y restaurar un usuario; descargar Excel e imprimir PDF desde Reportes; revisar Auditoría | Solo administración cambia contraseñas y ADMIN no gestiona SUPERADMIN. Archivar conserva el historial. Excel descarga; «Descargar PDF» abre la impresión del navegador. La auditoría muestra «Facturación sin stock» cuando corresponde. | Pendiente | ______ | ______ |

### Cómo interpretar desvíos

- Stock físico reducido al reservar: posible confusión entre reserva y entrega.
- Déficit 2 en vez de 7: posible doble descuento de lo reservado.
- Fila que desaparece tras entrada parcial: riesgo de perder el saldo por conseguir.
- Facturar sin stock **no es por sí solo un defecto**: existe excepción explícita y auditada. Sí es un desvío que cree inventario o permita entregar sin cobertura.
- Avisos duplicados o dirigidos a un rol en lugar del creador: registrar caso y evidencia; no darlo por validado al recargar una sola pantalla.

## Límites y pendientes de evidencia

- Código consultado para instrucciones y permisos: ver **Base verificada** del manual. Lectura de código no equivale a resultado manual en TEST.
- Concurrencia: los resultados PostgreSQL reportados son evidencia automatizada, no un ensayo manual reproducido aquí.
- Persistencia y destinatario de avisos, inventario tras entrega, permisos efectivos y recorrido completo deben confirmarse con las filas anteriores.
- [Runbook de restauración](RUNBOOK-RESTAURACION.md): referencia separada. **Ensayo de restauración no demostrado para este cierre**, aunque el texto histórico indique un ensayo previo. El script independiente está en `feat/restore-operativo`, no se declara integrado. No ejecutar restauraciones desde esta planilla.

## Acta borrador de entrega / aceptación de TEST

Estado: **sin completar / sin aceptación**. Registrar decisiones después del recorrido, no por la sola existencia del deploy o de estas guías.

| Campo | A completar |
| --- | --- |
| Fecha del recorrido / revisión TEST validada | ______ / ______ |
| Responsable de presentación (rol o referencia interna) | ______ |
| Responsable de verificación / aceptación (rol o referencia interna) | ______ |
| Casos aprobados y referencias de evidencia | ______ |
| Casos fallidos/no ejecutados, impacto y decisión | ______ |
| U2 depósito: evidencia y decisión | ______ |
| U6: pendientes resueltos o aún abiertos | ______ |
| U7: manual y guion recibidos; video/capacitación efectivamente realizados | ______ |
| Decisión TEST: aceptado / aceptado con pendientes explícitos / no aceptado | ______ |
| Fecha y constancia de la decisión | ______ |

Producción requiere **aprobación explícita y separada después de TEST**. Esta acta no autoriza un pase automático, no promete fechas y no establece condiciones de soporte, pago ni compromisos contractuales.

**Aprendizajes de cierre:** la evidencia de despliegue, las suites automatizadas y la aceptación manual responden preguntas distintas; los permisos de consulta y alta de Entradas son distintos; una excepción de facturación no reemplaza la recepción ni la entrega física.
