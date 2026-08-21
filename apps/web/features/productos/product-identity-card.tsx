import { Card, CardTitle } from "@/app/_components/ui/card";
import { OrionFixForm } from "@/features/productos/orion-fix-form";
import { OrionLinkForm } from "@/features/productos/orion-link-form";

type ProductIdentityCardProps = {
  productId: string;
  /** Código de Orion ya vinculado, o `null` si el producto todavía no tiene. */
  orionCode: string | null;
  /** SKU interno que acuñó el servidor, cuando existe. */
  internalSku: string | null;
  identityVersion: number;
  /** Si este operador puede vincular. Mirar no es lo mismo que poder cambiar. */
  canLink: boolean;
  /**
   * Si puede CORREGIR un código ya puesto. Es un eje distinto de `canLink`:
   * supervisión corrige el error que le reporta el vendedor, pero no da de alta
   * catálogo. Ver `canFixProductIdentity` en `lib/auth/permissions.ts`.
   */
  canFix: boolean;
};

// --------------------------------------------------------------------------
// La identidad del producto en su pantalla de detalle.
//
// Se muestra SIEMPRE, tenga código o no. Que un producto esté sin vincular es
// justamente lo que hay que ver de un vistazo: esconder la tarjeta cuando
// falta el dato sería esconder el trabajo pendiente, que es el que hace falta
// terminar para poder cuadrar inventario.
//
// Quien no puede vincular igual ve el estado. Saber que a un producto le falta
// identidad le sirve a cualquiera; cambiarla, no.
// --------------------------------------------------------------------------
export function ProductIdentityCard({
  productId,
  orionCode,
  internalSku,
  identityVersion,
  canLink,
  canFix,
}: ProductIdentityCardProps) {
  return (
    <Card className="space-y-3">
      <CardTitle>Identidad</CardTitle>

      {orionCode ? (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Código de Orion</p>
          <p className="break-words font-mono text-lg font-medium text-text">
            {orionCode}
          </p>
          {canFix ? (
            <OrionFixForm
              productId={productId}
              currentOrionCode={orionCode}
              identityVersion={identityVersion}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Vinculado. Este código no se cambia desde acá.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Este producto todavía no tiene su código de Orion. Sin él no se
            puede cuadrar el inventario.
          </p>
          {canLink ? (
            <OrionLinkForm productId={productId} identityVersion={identityVersion} />
          ) : null}
        </div>
      )}

      {internalSku ? (
        <p className="text-xs text-muted-foreground">
          Código interno:{" "}
          <span className="break-words font-mono">{internalSku}</span>
        </p>
      ) : null}
    </Card>
  );
}
