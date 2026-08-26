import { describe, expect, it } from 'vitest'
import { isNewer, newerRelease } from './newer.ts'

/** GitHub's answer to `/releases/latest`: a redirect, and the tag is in where it points. */
const redirectTo = (location: string) => async (): Promise<Response> =>
  new Response(null, { status: 302, headers: { location } })

const TAG = 'https://github.com/zihanyang-dev/handover/releases/tag'

describe('which of two releases is later', () => {
  it('reads the numbers rather than the string', () => {
    // `v0.10.0` sorts before `v0.9.0` as text, and a machine told it was up to date because of
    // that would stay on the older build forever.
    expect(isNewer('v0.9.0', 'v0.10.0')).toBe(true)
    expect(isNewer('v0.10.0', 'v0.9.0')).toBe(false)
  })

  it('says no to the one it already is', () => {
    expect(isNewer('v1.2.3', 'v1.2.3')).toBe(false)
  })

  it('says no about anything it cannot read as a release', () => {
    expect(isNewer('from source', 'v1.0.0')).toBe(false)
    expect(isNewer('v1.0.0', 'nightly')).toBe(false)
  })
})

describe('asking whether there is a newer build', () => {
  it('names it when there is one', async () => {
    expect(await newerRelease('v0.1.0', redirectTo(`${TAG}/v0.2.0`))).toBe('v0.2.0')
  })

  it('says nothing when this is the newest', async () => {
    expect(await newerRelease('v0.2.0', redirectTo(`${TAG}/v0.2.0`))).toBeUndefined()
  })

  it('says nothing when nothing has been released yet', async () => {
    // A repository with no releases redirects to the list instead of to a tag. That is the honest
    // state of a project that has not published one, and it is measured: it is what ours does.
    expect(
      await newerRelease(
        'v0.1.0',
        redirectTo('https://github.com/zihanyang-dev/handover/releases'),
      ),
    ).toBeUndefined()
  })

  it('says nothing when GitHub cannot be reached, rather than saying it is up to date', async () => {
    // Somebody who cannot reach GitHub is usually behind a firewall on purpose. Neither a notice
    // nor a claim to be current is owed — this is a question nobody asked.
    const refuses = async (): Promise<Response> => {
      throw new Error('getaddrinfo ENOTFOUND github.com')
    }

    expect(await newerRelease('v0.1.0', refuses)).toBeUndefined()
  })

  it('never asks at all when this is a working copy', async () => {
    // Nothing to be behind, and nothing to compare. Asking would spend somebody's connect on a
    // question with no answer.
    let asked = false
    const counting = async (): Promise<Response> => {
      asked = true
      return new Response(null, { status: 302 })
    }

    expect(await newerRelease('from source', counting)).toBeUndefined()
    expect(asked).toBe(false)
  })
})
