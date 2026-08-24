/**
 * What every provider has to offer, and nothing more.
 *
 * The dance differs — Google is OpenID Connect and says who somebody is inside the token it
 * returns; GitHub is plain OAuth 2.0 and has to be asked again afterwards. Neither difference is
 * allowed past this file. What comes out is an address somebody proved, or a reason it is not one.
 */

import type { ProviderIdentity } from '../../identity/provider.ts'

export type Handoff = {
  readonly url: URL
  readonly state: string
  readonly pkceVerifier: string
}

export type Returned = {
  /** The callback URL exactly as the browser arrived at it. */
  readonly url: URL
  readonly state: string
  readonly pkceVerifier: string
}

export type Identified =
  | { readonly kind: 'identified'; readonly identity: ProviderIdentity }
  /**
   * The provider had nothing verified to hand over. GitHub will give an address somebody typed
   * and never confirmed, and taking that as proof is how one person claims another's account.
   */
  | { readonly kind: 'no-verified-email' }

export type ProviderClient = {
  readonly begin: (redirectUri: string) => Promise<Handoff>
  readonly identify: (returned: Returned) => Promise<Identified>
}
