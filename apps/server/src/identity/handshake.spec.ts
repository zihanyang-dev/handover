import * as oauth from 'openid-client'
import { describe, expect, it } from 'vitest'
import { begin } from './handshake.ts'

/** A provider that exists only as metadata. Beginning a trip is all URL building — nothing is sent. */
const provider = new oauth.Configuration(
  {
    issuer: 'https://provider.example',
    authorization_endpoint: 'https://provider.example/authorize',
    token_endpoint: 'https://provider.example/token',
  },
  'a-client-id',
)

describe('beginning a trip through a provider', () => {
  it('carries a challenge and the state that brings the browser back to us', async () => {
    // The two halves of the same protection, and both are ours to send: `state` is what ties the
    // browser coming back to the one that left, and the challenge is what makes a stolen code
    // useless to whoever stole it. A missing one is not visible in any journey — the trip works
    // either way, right up until somebody attacks it.
    const handoff = await begin(provider, 'openid email', 'https://handover.example/auth/callback')
    const asked = handoff.url.searchParams

    expect(asked.get('state')).toBe(handoff.state)
    expect(asked.get('code_challenge_method')).toBe('S256')
    expect(asked.get('code_challenge')).not.toBe(handoff.pkceVerifier)
    expect(asked.get('redirect_uri')).toBe('https://handover.example/auth/callback')
    expect(asked.get('scope')).toBe('openid email')
  })

  it('is a different trip every time, which is the whole point of both', async () => {
    const one = await begin(provider, 'openid email', 'https://handover.example/auth/callback')
    const two = await begin(provider, 'openid email', 'https://handover.example/auth/callback')

    expect(one.state).not.toBe(two.state)
    expect(one.pkceVerifier).not.toBe(two.pkceVerifier)
  })

  it('sends the challenge and keeps the verifier, which is what makes it a challenge', async () => {
    // The verifier never leaves this process until the code comes back. Sent up front, it would
    // be in the browser's address bar and in the provider's logs, and the exchange would prove
    // nothing about who is exchanging.
    const handoff = await begin(provider, 'openid email', 'https://handover.example/auth/callback')

    expect(handoff.url.href).not.toContain(handoff.pkceVerifier)
  })
})
