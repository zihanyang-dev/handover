/**
 * Turning a display name into the path its Space is reachable at.
 *
 * The browser runs this exact function to preview the URL while the name is being typed, so there
 * is no preview endpoint and no second copy of the rule. The preview is not authority: the server
 * normalizes again, and the unique index decides who gets the name.
 */

/** A path segment that has been through {@link normalizeSlug}. Nothing else produces one. */
export type Slug = string & { readonly __brand: 'Slug' }

/** Long enough to keep real names whole, short enough to stay readable in a URL bar. */
const MAX_GRAPHEMES = 64

/**
 * A fixed locale, because the browser and the server have to agree character for character.
 * Graphemes rather than code points: combining marks are kept, so clipping by code point could
 * separate an accent from the letter it belongs to.
 */
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** Letters, digits and combining marks survive. Every other run collapses to one separator. */
const SEPARATORS = /[^\p{L}\p{N}\p{M}]+/gu

const EDGE_SEPARATORS = /^-+|-+$/gu

/** Clipping so that a name is never cut through the middle of a character. */
function clip(value: string): string {
  const graphemes = Array.from(GRAPHEMES.segment(value), (entry) => entry.segment)
  return graphemes.slice(0, MAX_GRAPHEMES).join('')
}

/**
 * Returns null when nothing usable survives: a name of pure punctuation has no URL. That is the
 * one way this fails, and the one recovery is a different name.
 *
 * Non-ASCII names keep their own characters — `徐悦泰` stays `徐悦泰`. Transliteration would need a
 * dictionary per script, and it guesses wrong on characters that have more than one reading.
 */
export function normalizeSlug(displayName: string): Slug | null {
  // NFKC folds the full-width Latin that CJK keyboards produce down to plain ASCII.
  const separated = displayName.normalize('NFKC').toLowerCase().replace(SEPARATORS, '-')
  const slug = clip(separated.replace(EDGE_SEPARATORS, '')).replace(EDGE_SEPARATORS, '')
  return slug === '' ? null : (slug as Slug)
}

/**
 * The name to offer when the one asked for is taken.
 *
 * It is a suggestion, not a reservation: nothing holds it, and submitting it can lose the same
 * race again. Numbering fills gaps rather than always climbing, so a Space deleted at `-2` gives
 * that number back instead of leaving everyone after it counting from `-3`.
 */
export function nextFreeSlug(base: Slug, taken: Iterable<string>): Slug {
  const used = new Set(taken)
  let suffix = 2
  while (used.has(`${base}-${String(suffix)}`)) suffix += 1
  return `${base}-${String(suffix)}` as Slug
}
