/**
 * Choosing the name a person is first shown under.
 *
 * It is deliberately recognisable as coming from how they signed in, never invented, and `prd.md`
 * puts the rename control on the same screen — the first moment the name becomes visible to anyone.
 */

/** What a sign-in told us about the person. Everything but the address may be missing. */
export type Profile = {
  readonly name: string | null
  readonly username: string | null
  readonly address: string
}

function stated(value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/**
 * Signing in by emailed code is the case where a provider told us nothing, so it needs no branch:
 * the address is what is left.
 */
export function initialDisplayName(profile: Profile): string {
  return stated(profile.name) ?? stated(profile.username) ?? profile.address
}
