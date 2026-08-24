/**
 * GitHub, which is plain OAuth 2.0: the token says nothing about who anybody is, so the address
 * has to be asked for afterwards — and asked for in the one place that says whether it is proved.
 */

import * as oauth from 'openid-client'
import { normalizeEmail } from '../../identity/email-address.ts'
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

export type Account = {
  readonly id: number
  readonly login: string
  readonly name: string | null
}

export type Address = {
  readonly email: string
  readonly primary: boolean
  readonly verified: boolean
}

async function ask<T>(
  config: oauth.Configuration,
  accessToken: string,
  path: string,
): Promise<T | undefined> {
  const response = await oauth.fetchProtectedResource(
    config,
    accessToken,
    new URL(`${API}${path}`),
    'GET',
    null,
    new Headers({ accept: 'application/vnd.github+json' }),
  )
  if (!response.ok) return undefined
  return (await response.json()) as T
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
        await ask<Account>(config, tokens.access_token, '/user'),
        await ask<Address[]>(config, tokens.access_token, '/user/emails'),
      )
    },
  }
}
