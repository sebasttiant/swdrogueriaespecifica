# Reparación auditada del producto del pendiente del incidente #330

Este comando está limitado en código a la corrección aprobada del incidente #330. Cualquier cambio de ID, identidad, cantidad, estado o actor bloquea la ejecución.

## Garantías

- El modo predeterminado es dry-run.
- El host debe ser exactamente `vpsovhcloudilasesorias`.
- `--apply` exige `CONFIRM_REPAIR_APPLY=apply-pending-product-repair`.
- La reparación bloquea actor, productos y pendiente antes de decidir.
- Cambia únicamente `productId`; Prisma actualiza `updatedAt` como testigo de concurrencia.
- Si existe actividad comercial, inventario, facturación, entrega, cancelación, reserva, asignación o faltante, aborta sin escribir.
- La auditoría `pending.update` se escribe en la misma transacción.
- Repetir una reparación aplicada devuelve `noop` y no duplica auditoría.

## Manifiesto aprobado

Creá `pending-product-repair.json` en el directorio del despliegue:

```json
{
  "repairId": "incident-330-laura-pending-product",
  "actorEmail": "admin@ilasesorias.com",
  "pendingId": "cmw15djdt00ph01qsk9oqssrp",
  "expectedCurrentProductId": "cmw15hzoy00pt01qs7m2g73b8",
  "expectedCurrentProductName": "ATODER CREMA ULTRA HYDRATANTE X 500 ML ref",
  "expectedCurrentProductOrionCode": "A33915",
  "targetProductId": "cmtvwdmrw00ce01nxpuzhebl8",
  "expectedQuantity": 2,
  "expectedStatus": "PENDIENTE",
  "expectedPurchaseStatus": "SOLICITADO",
  "expectedAvailabilityStatus": "ESPERANDO",
  "expectedCustomerStatus": "POR_CONTACTAR",
  "expectedTargetName": "CITIVITAE 1000 MG X 10 SOBRES",
  "expectedTargetOrionCode": "A33731",
  "reason": "Restore the product confirmed by the original request fingerprint and incident #330."
}
```

El manifiesto nunca acepta `apply`; la decisión de escritura existe solamente en la línea de comandos.

## Ejecución

Dry-run:

```bash
DEPLOY_TARGET=vpsovhcloudilasesorias \
  ./scripts/run-pending-product-repair.sh pending-product-repair.json
```

Aplicación explícita, únicamente después de revisar el dry-run:

```bash
DEPLOY_TARGET=vpsovhcloudilasesorias \
CONFIRM_REPAIR_APPLY=apply-pending-product-repair \
  ./scripts/run-pending-product-repair.sh pending-product-repair.json --apply
```

Repetí el dry-run. Debe devolver `Estado: noop` y `Aplicado: no`.
