import {
  listSuppliers,
  type SupplierOption,
} from "@/server/repositories/supplier.repository";

// Boundary de LECTURA de proveedores para la UI. La página delega acá y nunca
// toca el repositorio directo (mismo patrón que pendientes/faltantes).
//
// Las escrituras de proveedor (alta al vuelo durante un pedido) NO viven acá:
// ocurren dentro de la transacción de `orderMissingItem`, en
// `missing-item.service.ts`, para que el pedido y el alta sean atómicos.
export function getSuppliers(): Promise<SupplierOption[]> {
  return listSuppliers();
}
