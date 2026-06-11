// --------------------------------------------------------------------------
// Pure helpers for the product autocomplete (mobile topbar search).
// Kept framework-free so both the client overlay and the server action share a
// single source of truth for "is this query worth a round-trip?".
// --------------------------------------------------------------------------

// Below this length the autocomplete stays idle: a 1-char query matches almost
// everything and is not useful as a suggestion.
export const MIN_PRODUCT_QUERY_LENGTH = 2;

// Normalize a raw input value into a query worth searching, or null when it is
// too short. Trims surrounding whitespace before measuring length.
export function prepareProductQuery(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_PRODUCT_QUERY_LENGTH) return null;
  return trimmed;
}
