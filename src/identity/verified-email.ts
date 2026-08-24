/**
 * The address an account is anchored on.
 *
 * Case is folded. The standard only guarantees it for the domain, and lets a mail server treat the
 * part before the `@` as case-sensitive — but no provider anyone uses does, and nobody thinks of
 * `Mina@` and `mina@` as two inboxes. Letting them be two accounts is how somebody ends up locked
 * out of their own Spaces by their own address.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}
