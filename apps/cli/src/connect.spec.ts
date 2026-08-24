import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apiFor } from './api.ts'
import { askToConnect, connectWithKey, SAID, waitToBeLetIn, type Asked } from './connect.ts'

const server = setupServer()
const ORIGIN = 'http://handover.test'

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

const ASKED: Asked = {
  machineName: 'mina-mbp',
  secret: 'hk_secret',
  userCode: 'WDJB-MJHT',
  verifyUrl: `${ORIGIN}/connect`,
  verifyUrlComplete: `${ORIGIN}/connect/WDJB-MJHT`,
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
}

/** Never actually waits: what is under test is the loop, not the clock. */
function waiting(shown: Asked[] = []) {
  return { show: (asked: Asked) => shown.push(asked), sleep: async () => undefined }
}

function answers(...kinds: string[]) {
  let asked = 0
  return http.post(`${ORIGIN}/enrolments/collect`, () => {
    const kind = kinds[Math.min(asked, kinds.length - 1)]
    asked += 1
    return HttpResponse.json(
      kind === 'granted'
        ? { kind, token: 'hm_token', machineId: 'm-1', lookFor: ['claude'] }
        : { kind },
    )
  })
}

describe('asking to come in', () => {
  it('carries the name this machine calls itself', async () => {
    let asked: unknown
    server.use(
      http.post(`${ORIGIN}/enrolments`, async ({ request }) => {
        asked = await request.json()
        return HttpResponse.json({ ...ASKED }, { status: 201 })
      }),
    )

    await askToConnect(apiFor(ORIGIN), 'mina-mbp')

    expect(asked).toMatchObject({ machineName: 'mina-mbp' })
  })

  it('says why when the server would not even take the question', async () => {
    // Nothing to loop over here: a machine that cannot ask has nothing to wait for.
    server.use(
      http.post(`${ORIGIN}/enrolments`, () =>
        HttpResponse.json({ reason: 'malformed-request', recovery: 'retype' }, { status: 400 }),
      ),
    )

    await expect(askToConnect(apiFor(ORIGIN), 'mina-mbp')).rejects.toThrow('malformed-request')
  })
})

describe('waiting to be let in', () => {
  it('shows what to open and what to type, once', async () => {
    const shown: Asked[] = []
    server.use(answers('granted'))

    await waitToBeLetIn(apiFor(ORIGIN), ORIGIN, ASKED, waiting(shown))

    expect(shown).toEqual([ASKED])
  })

  it('sits through waiting, which is the ordinary answer', async () => {
    // Waiting is not a failure and must not end the attempt. A loop that gave up on it would give
    // up on every connection where somebody took a moment to reach for their phone.
    server.use(answers('waiting', 'waiting', 'waiting', 'granted'))

    const connected = await waitToBeLetIn(apiFor(ORIGIN), ORIGIN, ASKED, waiting())

    expect(connected).toMatchObject({ kind: 'connected' })
  })

  it('keeps the credential it was handed, not the secret it asked with', async () => {
    server.use(answers('granted'))

    const connected = await waitToBeLetIn(apiFor(ORIGIN), ORIGIN, ASKED, waiting())

    expect(connected).toMatchObject({
      kind: 'connected',
      attachment: { origin: ORIGIN, machineId: 'm-1', token: 'hm_token', lookFor: ['claude'] },
    })
  })

  it.each(['refused', 'expired', 'spent', 'no-enrolment'])('gives up on %s', async (kind) => {
    server.use(answers(kind))

    expect(await waitToBeLetIn(apiFor(ORIGIN), ORIGIN, ASKED, waiting())).toEqual({
      kind: 'gave-up',
      why: kind,
    })
  })

  it('keeps asking through a server that is briefly gone', async () => {
    // Nothing about the enrolment changed while the network was down, so the only thing that
    // would end the attempt here is impatience.
    let asked = 0
    server.use(
      http.post(`${ORIGIN}/enrolments/collect`, () => {
        asked += 1
        if (asked < 3) return HttpResponse.error()
        return HttpResponse.json({ kind: 'granted', token: 'hm_t', machineId: 'm', lookFor: [] })
      }),
    )

    const connected = await waitToBeLetIn(apiFor(ORIGIN), ORIGIN, ASKED, waiting())

    expect(connected.kind).toBe('connected')
    expect(asked).toBe(3)
  })
})

describe('coming in with a key', () => {
  it('does not wait, because generating the key was the approving', async () => {
    server.use(answers('granted'))

    const connected = await connectWithKey(apiFor(ORIGIN), ORIGIN, 'hk_key', 'build-server-1')

    expect(connected).toMatchObject({ kind: 'connected', attachment: { lookFor: ['claude'] } })
  })

  it('says what it calls itself, because nobody named it when the key was made', async () => {
    let sent: unknown
    server.use(
      http.post(`${ORIGIN}/enrolments/collect`, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json({ kind: 'granted', token: 'hm_t', machineId: 'm', lookFor: [] })
      }),
    )

    await connectWithKey(apiFor(ORIGIN), ORIGIN, 'hk_key', 'build-server-1')

    expect(sent).toEqual({ secret: 'hk_key', machineName: 'build-server-1' })
  })

  it('gives up on a key somebody else already used, rather than waiting for nothing', async () => {
    // There is nobody to wait for. A key that is spent will not become unspent.
    server.use(answers('spent'))

    expect(await connectWithKey(apiFor(ORIGIN), ORIGIN, 'hk_key', 'build-server-1')).toEqual({
      kind: 'gave-up',
      why: 'spent',
    })
  })

  it('gives up when the server cannot be reached at all', async () => {
    server.use(http.post(`${ORIGIN}/enrolments/collect`, () => HttpResponse.error()))

    expect(await connectWithKey(apiFor(ORIGIN), ORIGIN, 'hk_key', 'build-server-1')).toEqual({
      kind: 'gave-up',
      why: 'unreachable',
    })
  })
})

describe('what somebody is told when it does not work', () => {
  it('sends them somewhere different depending on which door they used', () => {
    // The same word off the wire is two situations. At a terminal showing a code, `spent` means
    // somebody else typed it and asking again here is the fix. With a key, it means that key is
    // used up and the fix is in the Space. Telling either one the other's sentence sends them to
    // the wrong screen.
    expect(SAID.code.spent).toContain('Run this again')
    expect(SAID.key.spent).toContain('Space')
  })

  it('never hands back the word the wire used, which names nothing anybody can act on', () => {
    for (const door of Object.values(SAID)) {
      for (const [why, said] of Object.entries(door)) {
        expect(said).not.toContain(why)
      }
    }
  })
})
