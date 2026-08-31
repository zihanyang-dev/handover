/**
 * The half of the dance that is the same at every provider.
 *
 * PKCE on both, because GitHub has accepted it since July 2025 and there is no longer a reason to
 * have one provider protected differently from the other. `state` stays too: it is what ties the
 * browser coming back to the one that left, and PKCE alone does not say where to send it.
 */

import * as oauth from 'openid-client'
import type { SettingOut, Returned } from './provider-client.ts'

export async function begin(
  config: oauth.Configuration,
  scope: string,
  redirectUri: string,
): Promise<SettingOut> {
  const pkceVerifier = oauth.randomPKCECodeVerifier()
  const state = oauth.randomState()

  const url = oauth.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: await oauth.calculatePKCECodeChallenge(pkceVerifier),
    // The only method GitHub accepts, and the only one worth using anywhere.
    code_challenge_method: 'S256',
  })

  return { url, state, pkceVerifier }
}

/**
 * Exchanges the code for tokens, refusing anything that does not match the trip that was started.
 * Both checks are the library's to enforce, so no caller can forget one.
 */
export async function exchange(config: oauth.Configuration, returned: Returned) {
  return oauth.authorizationCodeGrant(config, returned.url, {
    pkceCodeVerifier: returned.pkceVerifier,
    expectedState: returned.state,
  })
}
