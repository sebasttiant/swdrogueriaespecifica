// --------------------------------------------------------------------------
// The management observation on a pending — normalisation and presentation.
//
// Pure module, no Prisma and no server imports, so the client form, the server
// action and the tests all measure the text with the SAME ruler. When the two
// sides normalise differently, "save the same text twice" stops being a no-op
// on one of them and the seller gets a notice about a change that never
// happened.
// --------------------------------------------------------------------------

/**
 * Ceiling on the stored text. It is a note to a colleague about one order, not
 * a document: 500 characters is roughly a full screen on a phone, and the form
 * says so before the server has to reject anything.
 */
export const MANAGEMENT_OBSERVATION_MAX_LENGTH = 500;

/** How much of the observation the list shows before it has to be opened. */
export const MANAGEMENT_OBSERVATION_SUMMARY_LENGTH = 120;

/**
 * The single normalisation of an observation.
 *
 * Collapses the runs of whitespace a phone keyboard leaves behind and trims the
 * ends. Blank input — spaces, newlines, nothing at all — normalises to `null`,
 * which is how the observation is cleared: there is no separate "delete"
 * command to keep in sync with this one.
 *
 * Line breaks survive as single newlines: gerencia writes lists.
 */
export function normalizeManagementObservation(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const collapsed = raw
    .replace(/\r\n?/g, "\n")
    // Spaces and tabs collapse; a newline is content, so it is preserved.
    .replace(/[^\S\n]+/g, " ")
    // Three blank lines in a row are a paste artefact, not a paragraph break.
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
  return collapsed.length === 0 ? null : collapsed;
}

/**
 * Whether the normalised text fits. Checked on both sides: the form to say it
 * early, the action because a form is not a boundary.
 */
export function isManagementObservationTooLong(text: string | null): boolean {
  return text !== null && text.length > MANAGEMENT_OBSERVATION_MAX_LENGTH;
}

/**
 * Whether writing `next` over `current` is a real change.
 *
 * This is what keeps a second save of the same text from bumping the version
 * and waking the seller for nothing. Both sides are normalised first, so
 * trailing whitespace never counts as news.
 */
export function isManagementObservationChanged(
  current: string | null,
  next: string | null,
): boolean {
  return normalizeManagementObservation(current) !== normalizeManagementObservation(next);
}

/**
 * The first line of the observation, clipped for the list.
 *
 * Clipping happens on a word boundary when there is one close enough, so the
 * summary does not end mid-word. The full text stays one tap away — the summary
 * is never the only way to read it.
 */
export function managementObservationSummary(
  text: string | null,
  limit = MANAGEMENT_OBSERVATION_SUMMARY_LENGTH,
): string | null {
  const normalized = normalizeManagementObservation(text);
  if (normalized === null) return null;
  const singleLine = normalized.replace(/\n+/g, " · ");
  if (singleLine.length <= limit) return singleLine;
  const clipped = singleLine.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(" ");
  // Only respect the word boundary when it does not eat most of the summary.
  const cut = lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut.trimEnd()}…`;
}

/**
 * Whether this observation is newer than what the seller has already read.
 *
 * Derived from the presence of text AND the version, never from a stored
 * boolean: a boolean set to "read" would swallow the next edit, and an
 * observation that was cleared would leave the notice pointing at nothing.
 */
export function hasUnreadManagementObservation(params: {
  observation: string | null;
  version: number;
  readVersion: number | null | undefined;
}): boolean {
  if (normalizeManagementObservation(params.observation) === null) return false;
  return params.version > (params.readVersion ?? 0);
}
