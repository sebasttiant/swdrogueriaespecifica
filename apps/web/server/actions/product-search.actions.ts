"use server";

import { requireSession } from "@/lib/auth/require-role";
import { prepareProductQuery } from "@/lib/productos/search-query";
import { getProducts } from "@/server/services/product.service";

// --------------------------------------------------------------------------
// Read-only Server Action backing the mobile topbar autocomplete. Any active
// session may read the catalog (same rule as the /productos page). Returns a
// small, flat suggestion list — never the full paginated payload.
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
