"use server";

import { requireSession } from "@/lib/auth/require-role";
import { prepareProductQuery } from "@/lib/productos/search-query";
import { getProducts } from "@/server/services/product.service";

// --------------------------------------------------------------------------
// Read-only Server Action backing the mobile topbar autocomplete and the
// product pickers of the pending and missing-item forms.
//
// The guard is `requireSession`, deliberately NOT `canViewProductos`. Picking a
// product to work with and browsing the catalog module are different things: a
// seller who may not open /productos still has to name the product of a pending
// or a missing-item report, and gating this on the module capability would
// break that flow the moment the module is taken away from a role.
//
// This once read "same rule as the /productos page". That stopped being true
// when OPERADOR lost `canViewProductos`; the rule below is the one that holds.
//
// Returns a small, flat suggestion list — never the full paginated payload.
// --------------------------------------------------------------------------

export type ProductSuggestion = {
  id: string;
  code: string;
  name: string;
  unit: string;
};

const SUGGESTION_LIMIT = 8;

export async function searchProductsAction(
  rawQuery: string,
): Promise<ProductSuggestion[]> {
  await requireSession();

  const q = prepareProductQuery(rawQuery);
  if (!q) return [];

  const { items } = await getProducts({ q, take: SUGGESTION_LIMIT });
  return items.map((product) => ({
    id: product.id,
    code: product.code,
    name: product.name,
    unit: product.unit,
  }));
}
