/**
 * GitHub, which is plain OAuth 2.0: the token says nothing about who anybody is, so the address
 * has to be asked for afterwards — and asked for in the one place that says whether it is proved.
 */

import * as oauth from 'openid-client'
import { z } from 'zod'
import { normalizeEmail } from './email-address.ts'
import { begin, exchange } from './handshake.ts'
import type { Identified, ProviderClient } from './provider-client.ts'

/**
 * No discovery document to fetch: GitHub is not OpenID Connect, so the endpoints are stated.
 *
 * The issuer is `/login/oauth`, not `github.com`. GitHub sends `iss` back on the callback and it
 * is checked against this, so the shorter, more obvious value fails every sign-in.
 */
const SERVER: oauth.ServerMetadata = {
  issuer: 'https://github.com/login/oauth',
  authorization_endpoint: 'https://github.com/login/oauth/authorize',
  token_endpoint: 'https://github.com/login/oauth/access_token',
}

const SCOPE = 'read:user user:email'

const API = 'https://api.github.com'

/**
 * What GitHub sends back, parsed rather than assumed.
 *
 * This is somebody else's JSON arriving at the one boundary where being wrong hands over an
 * account. Asserted instead — which is what this did — a `verified` that came back as the string
 * "false" is a truthy value, and an account with no `id` becomes the subject `"undefined"`, which
 * every later sign-in with no id would match.
 */
const Account = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable(),
})

const Address = z.object({
  email: z.string(),
  primary: z.boolean(),
  verified: z.boolean(),
})

const Addresses = z.array(Address)

export type Account = z.infer<typeof Account>
export type Address = z.infer<typeof Address>

/**
 * Asks GitHub for one thing, and comes back with it only if it is what it claims to be.
 *
 * Nothing to recover here: a shape that will not read and a request that failed leave the same
 * caller with the same nothing, and the rule above decides what that means.
 */
async function ask<T>(
  config: oauth.Configuration,
  accessToken: string,
  path: string,
  shape: z.ZodType<T>,
): Promise<T | undefined> {
  const endpoint = URL.parse(`${API}${path}`)
  if (endpoint === null) return undefined

  const response = await oauth.fetchProtectedResource(
    config,
    accessToken,
    endpoint,
    'GET',
    null,
    new Headers({ accept: 'application/vnd.github+json' }),
  )
  if (!response.ok) return undefined

  const read = shape.safeParse(await response.json())
  return read.success ? read.data : undefined
}

/**
 * The address GitHub shows on a profile is whatever somebody typed there. Only `/user/emails`
 * says which ones they proved, and only a proved one may become an identity here.
 *
 * Separated from the two requests that feed it because this is the whole of the rule, and a rule
 * only reachable through a signed token exchange is a rule nothing checks.
 */
export function identityFrom(
  account: Account | undefined,
  addresses: readonly Address[] | undefined,
): Identified {
  const verified = (addresses ?? []).filter((address) => address.verified)
  const email = (verified.find((address) => address.primary) ?? verified[0])?.email

  if (account === undefined || email === undefined) return { kind: 'no-verified-email' }

  return {
    kind: 'identified',
    identity: {
      provider: 'github',
      subject: String(account.id),
      verifiedEmail: normalizeEmail(email),
      name: account.name,
      username: account.login,
    },
  }
}

export function githubClient(clientId: string, clientSecret: string): ProviderClient {
  const config = new oauth.Configuration(SERVER, clientId, clientSecret)

  return {
    begin: async (redirectUri) => begin(config, SCOPE, redirectUri),

    identify: async (returned): Promise<Identified> => {
      const tokens = await exchange(config, returned)

      return identityFrom(
        await ask(config, tokens.access_token, '/user', Account),
        await ask(config, tokens.access_token, '/user/emails', Addresses),
      )
    },
  }
}
