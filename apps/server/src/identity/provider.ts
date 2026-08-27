/**
 * Who else can vouch for somebody.
 *
 * The list lives here and nowhere else. Everything that only needs to know *which* providers
 * exist reads it; everything that needs to know *how* one works reads its own module,
 * because Google is OpenID Connect and GitHub is OAuth 2.0 with a second call for the address,
 * and a table pretending those are the same shape would be a table that lies.
 *
 * An adapter still writes its own name once, in its own file — `github.ts` says `github`. That is
 * not a second list: it is the one place that knows which provider it is talking to, and `Provider`
 * makes a typo a compile error rather than a row nobody can sign in with.
 *
 * The order is the order they are offered in. That is a product decision, so it is stated once.
 */

export const PROVIDERS = ['google', 'github'] as const

export type Provider = (typeof PROVIDERS)[number]

export type ProviderIdentity = {
  readonly provider: Provider
  /**
   * The provider's own stable id for this person, never their address. They may change their
   * address over there, and the link has to survive it.
   */
  readonly subject: string
  /**
   * Verified over there, or this value must not exist. An address nobody proved is the whole of
   * account takeover: anybody could claim somebody else's and be handed their account.
   */
  readonly verifiedEmail: string
  readonly name: string | null
  readonly username: string | null
}
