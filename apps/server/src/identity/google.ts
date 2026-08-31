/**
 * Google, which is OpenID Connect: it says who somebody is inside the token, so nothing has to be
 * asked afterwards.
 */

import * as oauth from 'openid-client'
import { normalizeEmail } from './email-address.ts'
import { begin, exchange } from './handshake.ts'
import type { Identified, ProviderClient } from './provider-client.ts'

const ISSUER = googleIssuer()

function googleIssuer(): URL {
  const issuer = URL.parse('https://accounts.google.com')
  if (issuer === null) throw new Error('Google issuer is not a URL')
  return issuer
}
const SCOPE = 'openid email profile'

/**
 * `email_verified` is the whole of what makes this an identity. An address Google holds but has
 * not confirmed proves nothing, and taking it as proof hands over somebody's account.
 *
 * Separated from the token exchange because this is the whole of the rule, and a rule only
 * reachable through a signed token exchange is a rule nothing checks.
 */
export function identityFrom(claims: oauth.IDToken | undefined): Identified {
  const email = claims?.['email']
  const name = claims?.['name']

  if (claims === undefined || claims['email_verified'] !== true || typeof email !== 'string') {
    return { kind: 'no-verified-email' }
  }

  return {
    kind: 'identified',
    identity: {
      provider: 'google',
      subject: claims.sub,
      verifiedEmail: normalizeEmail(email),
      name: typeof name === 'string' ? name : null,
      username: null,
    },
  }
}

/**
 * Discovery happens once, at startup. If Google cannot be reached the process should find out
 * then, not the first time somebody tries to sign in.
 */
export async function googleClient(
  clientId: string,
  clientSecret: string,
): Promise<ProviderClient> {
  const config = await oauth.discovery(ISSUER, clientId, clientSecret)

  return {
    begin: async (redirectUri) => begin(config, SCOPE, redirectUri),

    identify: async (returned): Promise<Identified> =>
      identityFrom((await exchange(config, returned)).claims()),
  }
}
