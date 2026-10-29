# Recepción controlada de inventario sin SKU

Permitir continuidad operativa sin esconder deuda de identidad ni relajar las guardas de código de Orión.
La recepción excepcional debe ser explícita, auditable, idempotente y visible hasta que el producto sea identificado.

## Specs

1. **S1.** “y ademas ver si es error que n ose puede cargar inventario sin sku eso si quedo asi o es opcional hasta donde sabia eso era opcional”
2. **S2.** “entonces como corregimos eso sin dañar la operacion con ayuda para evitar descuadres que es lo mejor”
3. **S3.** “listo dale aplica eso si es correcto y hazlo de manewra organiza y clara y todo y evitemos esos errores entonces tambien arreglemos para que todo eso funcione correcto y no vuelva a fallar”

## Tasks

- [x] **T1 · S1-S3 · parent · `6e1a604c`:** modelar una excepción de identidad cerrada sobre la entrada, reutilizando los motivos existentes y una migración aditiva.
- [x] **T2 · S1-S3 · parent · `6e1a604c`:** cambiar el servicio y la acción con RED/GREEN para permitir la excepción solamente con confirmación y motivo, dentro de una transacción auditada e idempotente.
- [x] **T3 · S1-S3 · parent · `a42a3ffb`:** implementar el flujo de interfaz: advertencia, confirmación explícita, motivo obligatorio y nota opcional, sin mostrar la excepción cuando el producto ya tiene SKU.
- [x] **T4 · S2-S3 · parent · `a495217d`:** incorporar las recepciones sin SKU a la cola de identidad y priorizarlas sin borrar historia al resolver el código.
- [x] **T5 · S1-S3 · parent · `a495217d`:** verificar PostgreSQL real, regresiones del flujo con SKU, auditoría, idempotencia, conflictos de código, typecheck, lint y build; actualizar ayuda o documentación operativa aplicable.
- [x] **T6 · S2-S3 · independent verifier · no commit:** ejecutar verificación independiente por riesgo de datos y concurrencia antes de declarar la mejora liberable.

## Log

- **L1.** “listo dale aplica eso si es correcto y hazlo de manewra organiza y clara y todo y evitemos esos errores entonces tambien arreglemos para que todo eso funcione correcto y no vuelva a fallar”
- **L2.** La regla existente permite crear productos y pendientes sin SKU, pero bloquea toda entrada de inventario desde `f9c38007` / PR #244. El cambio no proviene del incidente SEDATIF.
- **L3.** Exploración read-only: reutilizar `PendingIdentityDeferral`; persistir motivo y nota en `InventoryEntry`; incluirlos condicionalmente en la huella idempotente; auditar la excepción dentro de la transacción; derivar la cola desde pendientes y entradas aún sin resolver; nunca asignar ni cambiar `orionCode` por la vía de recepción.
- **L4.** T1 GREEN: `inventoryEntryCreateSchema` exige confirmación + motivo cerrado, rechaza evidencia sin confirmación y conserva intacto el flujo normal; 22/22. Migración aditiva `20261029193000_add_inventory_identity_exception` sin backfill ni default, con restricción nota→motivo e índices parciales.
- **L5.** T2 GREEN: 10/10 PostgreSQL en base aislada. Sin confirmación conserva el bloqueo; con confirmación persiste entrada/lote sin inventar SKU; auditoría transaccional sin nota libre; fallo de auditoría revierte todo; replay exacto es idempotente y cambiar motivo rechaza.
- **L6.** T3 GREEN: advertencia y excepción solo para productos sin SKU, motivo visible únicamente tras confirmar, enlace al producto exacto; 59/59 focalizadas junto con action/schema.
- **L7.** T4 GREEN: cola unificada prioriza productos con mercadería física, muestra recepciones y unidades, mantiene alcance/paginación y desaparece al vincular sin borrar historia; 61 unitarias + 16 PostgreSQL.
- **L8.** T5 GREEN: 3076/3076 unitarias, typecheck, lint y build. PostgreSQL completo: 655 aprobadas y dos fallas de orden por collation ya reproducidas en la base; ejecución del candidato excluyendo únicamente esos dos archivos: 603 aprobadas y 2 fallas esperadas en 60/60 archivos.
- **L9.** T6 PASS independiente para S1, S2 y S3, sin hallazgos severos: 120/120 unitarias focalizadas, 26/26 PostgreSQL y `git diff --check` limpio. Confirmó validación explícita, rollback de auditoría, idempotencia, rechazo obsoleto, ausencia de asignación/revinculación de `orionCode`, prioridad de inventario y conservación histórica.
