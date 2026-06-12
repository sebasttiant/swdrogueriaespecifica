import { describe, expect, it } from "vitest";

import {
  buildAuditSummary,
  formatAuditAction,
  formatAuditEntity,
  formatAuditModule,
} from "./audit-format";

describe("formatAuditAction", () => {
  it("traduce los códigos canónicos a etiquetas humanas", () => {
    expect(formatAuditAction("auth.login")).toBe("Inicio de sesión");
    expect(formatAuditAction("auth.logout")).toBe("Cierre de sesión");
    expect(formatAuditAction("auth.login.failed")).toBe(
      "Intento fallido de inicio de sesión",
    );
    expect(formatAuditAction("product.create")).toBe("Producto creado");
    expect(formatAuditAction("product.update")).toBe("Producto actualizado");
    expect(formatAuditAction("product.deactivate")).toBe("Producto desactivado");
    expect(formatAuditAction("pending.create")).toBe("Pendiente creado");
    expect(formatAuditAction("pending.status.change")).toBe(
      "Cambio de estado de pendiente",
    );
    expect(formatAuditAction("missing.create")).toBe("Faltante generado");
    expect(formatAuditAction("missing.auto.create")).toBe(
      "Faltante generado automáticamente",
    );
    expect(formatAuditAction("missing.status.change")).toBe(
      "Cambio de estado de faltante",
    );
    expect(formatAuditAction("missing.closed.by.entry")).toBe(
      "Faltante cerrado por una entrada",
    );
    expect(formatAuditAction("entry.create")).toBe("Entrada registrada");
    expect(formatAuditAction("user.create")).toBe("Usuario creado");
    expect(formatAuditAction("user.update")).toBe("Usuario actualizado");
    expect(formatAuditAction("user.activate")).toBe("Usuario activado");
    expect(formatAuditAction("user.deactivate")).toBe("Usuario desactivado");
    expect(formatAuditAction("user.archive")).toBe("Usuario archivado");
    expect(formatAuditAction("user.restore")).toBe("Usuario restaurado");
    expect(formatAuditAction("report.export")).toBe("Reporte exportado");
    expect(formatAuditAction("file.import")).toBe("Archivo importado");
    expect(formatAuditAction("admin.change")).toBe("Cambio administrativo");
  });

  it("humaniza de forma segura una acción no contemplada", () => {
    expect(formatAuditAction("inventory.bulk_adjust")).toBe(
      "Inventory bulk adjust",
    );
  });

  it("no rompe ante una acción vacía o inválida", () => {
    expect(formatAuditAction("")).toBe("Acción desconocida");
    expect(formatAuditAction("   ")).toBe("Acción desconocida");
  });
});

describe("formatAuditModule", () => {
  it("traduce los módulos canónicos a nombres de negocio", () => {
    expect(formatAuditModule("auth")).toBe("Accesos al sistema");
    expect(formatAuditModule("productos")).toBe("Productos");
    expect(formatAuditModule("usuarios")).toBe("Usuarios");
    expect(formatAuditModule("pendientes")).toBe("Pendientes");
    expect(formatAuditModule("entradas")).toBe("Entradas");
    expect(formatAuditModule("faltantes")).toBe("Faltantes");
    expect(formatAuditModule("reportes")).toBe("Reportes");
    expect(formatAuditModule("auditoria")).toBe("Auditoría");
    expect(formatAuditModule("admin")).toBe("Administración");
  });

  it("humaniza de forma segura un módulo no contemplado", () => {
    expect(formatAuditModule("control_calidad")).toBe("Control calidad");
  });

  it("no rompe ante un módulo vacío", () => {
    expect(formatAuditModule("")).toBe("Módulo desconocido");
  });
});

describe("formatAuditEntity", () => {
  it("usa nombres legibles por tipo de entidad", () => {
    expect(formatAuditEntity("User", "cmq8abc123").label).toBe(
      "Usuario del sistema",
    );
    expect(formatAuditEntity("Product", "p1").label).toBe("Producto");
    expect(formatAuditEntity("Pending", "p1").label).toBe("Pendiente");
    expect(formatAuditEntity("MissingItem", "m1").label).toBe("Faltante");
    expect(formatAuditEntity("InventoryEntry", "e1").label).toBe(
      "Entrada de inventario",
    );
  });

  it("expone el ID solo como referencia secundaria, nunca como principal", () => {
    const result = formatAuditEntity("User", "cmq8abc123");
    expect(result.reference).toBe("cmq8abc123");
  });

  it("omite la referencia cuando no hay ID", () => {
    expect(formatAuditEntity("User", null).reference).toBeNull();
  });

  it("usa una etiqueta genérica segura para entidades no contempladas", () => {
    expect(formatAuditEntity("WeirdThing", "x1").label).toBe(
      "Registro relacionado",
    );
    expect(formatAuditEntity("", null).label).toBe("Registro relacionado");
  });
});

describe("buildAuditSummary", () => {
  it("describe en lenguaje de negocio quién hizo qué", () => {
    expect(
      buildAuditSummary({
        actor: "Super Admin",
        action: "auth.login",
        result: "SUCCESS",
      }),
    ).toBe("Super Admin inició sesión.");
    expect(
      buildAuditSummary({
        actor: "Super Admin",
        action: "auth.logout",
        result: "SUCCESS",
      }),
    ).toBe("Super Admin cerró sesión.");
    expect(
      buildAuditSummary({
        actor: "Super Admin",
        action: "product.create",
        result: "SUCCESS",
      }),
    ).toBe("Super Admin creó un producto.");
    expect(
      buildAuditSummary({
        actor: "Super Admin",
        action: "user.update",
        result: "SUCCESS",
      }),
    ).toBe("Super Admin actualizó un usuario.");
  });

  it("marca los intentos fallidos sin romper la frase", () => {
    expect(
      buildAuditSummary({
        actor: "Super Admin",
        action: "auth.login.failed",
        result: "FAILURE",
      }),
    ).toBe("Super Admin intentó iniciar sesión sin éxito.");
    expect(
      buildAuditSummary({
        actor: "Sistema",
        action: "product.create",
        result: "FAILURE",
      }),
    ).toBe("Sistema creó un producto sin éxito.");
  });

  it("genera una frase segura para acciones no contempladas", () => {
    expect(
      buildAuditSummary({
        actor: "Super Admin",
        action: "inventory.bulk_adjust",
        result: "SUCCESS",
      }),
    ).toBe('Super Admin realizó la acción "Inventory bulk adjust".');
  });
});
