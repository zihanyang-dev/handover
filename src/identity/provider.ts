/** What a sign-in provider tells us about somebody, once they have come back from it. */

export type Provider = 'google' | 'github'

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
