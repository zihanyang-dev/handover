import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apiFor } from './api.ts'
import { keepCheckingIn, reportOnce } from './checking-in.ts'

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

/** Stops after a fixed number of check-ins: what is under test is the loop, not the clock. */
function runningFor(rounds: number) {
  const said: string[] = []
  const stopping = new AbortController()
  let left = rounds

  return {
    said,
    signal: stopping.signal,
    running: {
      env: { PATH: '/nonexistent' },
      say: (line: string) => said.push(line),
      sleep: async () => {
        left -= 1
        if (left <= 0) stopping.abort()
      },
    },
  }
}

function keepsAnswering(reports: unknown[] = [], lookFor: string[] = []) {
  return http.post(`${ORIGIN}/machines/current/poll`, async ({ request }) => {
    reports.push(await request.json())
    return HttpResponse.json({ pollSeconds: 25, lookFor })
  })
}

describe('staying connected', () => {
  it('reports what it found, every time', async () => {
    const reports: unknown[] = []
    server.use(keepsAnswering(reports))
    const { running, signal } = runningFor(3)

    await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    expect(reports).toHaveLength(3)
  })

  it('follows the list the server tells it, without being restarted', async () => {
    // The deployment decides what it knows how to run. A machine carrying its own list would
    // report agents the server drops, or hide ones it could have used.
    const reports: { found: unknown[] }[] = []
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, async ({ request }) => {
        reports.push((await request.json()) as { found: unknown[] })
        return HttpResponse.json({ pollSeconds: 25, lookFor: ['some-new-agent'] })
      }),
    )
    const { running, signal } = runningFor(2)

    await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    // Nothing found either time — the point is that it went looking for a command nobody
    // compiled into it.
    expect(reports).toHaveLength(2)
  })

  it('stops for good once the machine has been taken away', async () => {
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, () =>
        HttpResponse.json({ reason: 'no-machine', recovery: 'start-over' }, { status: 401 }),
      ),
    )
    const { running, signal } = runningFor(5)

    const stopped = await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    expect(stopped).toEqual({ kind: 'removed' })
  })

  it('keeps trying through a server that is gone, and says so once it is back', async () => {
    let asked = 0
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, () => {
        asked += 1
        if (asked < 3) return HttpResponse.error()
        return HttpResponse.json({ pollSeconds: 25, lookFor: [] })
      }),
    )
    const { running, signal, said } = runningFor(4)

    const stopped = await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)

    expect(stopped).toEqual({ kind: 'asked-to-stop' })
    expect(said.filter((line) => line.includes('cannot reach'))).toHaveLength(2)
  })

  it('stops when it is asked to', async () => {
    server.use(keepsAnswering())
    const { running, signal } = runningFor(1)

    expect(await keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, signal)).toEqual({
      kind: 'asked-to-stop',
    })
  })
})

describe('being asked to stop', () => {
  it('stops without waiting out the sleep it is in, or the goodbye comes too late', async () => {
    // Stopping a service is a SIGTERM and then a kill a few seconds later. Noticing only when a
    // twenty-five second sleep ends means being killed first, and the Space showing a machine
    // that is gone as here for another minute.
    server.use(keepsAnswering())
    const stopping = new AbortController()
    const running = {
      env: {},
      say: () => undefined,
      sleep: async (seconds: number, until: AbortSignal) =>
        new Promise<void>((wake) => {
          const timer = setTimeout(wake, seconds * 1000)
          until.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              wake()
            },
            { once: true },
          )
        }),
    }

    const stopped = keepCheckingIn(apiFor(ORIGIN, 'hm_t'), [], running, stopping.signal)
    await new Promise((wake) => setTimeout(wake, 50))
    stopping.abort()

    expect(await stopped).toEqual({ kind: 'asked-to-stop' })
  })
})

describe('one report, and what came of it', () => {
  const env = { PATH: '/nonexistent' }

  it('is here when the server took it', async () => {
    server.use(keepsAnswering([], ['claude']))

    expect(await reportOnce(apiFor(ORIGIN, 'hm_t'), [], env)).toMatchObject({
      said: 'here',
      lookFor: ['claude'],
      pollSeconds: 25,
    })
  })

  it('is not ours when the credential is not one the server knows', async () => {
    // What being taken out of a Space looks like from here. It is also what `connect` asks when
    // it finds an attachment on disk: a file is not a connection.
    server.use(
      http.post(`${ORIGIN}/machines/current/poll`, () =>
        HttpResponse.json({ reason: 'no-machine', recovery: 'start-over' }, { status: 401 }),
      ),
    )

    expect(await reportOnce(apiFor(ORIGIN, 'hm_t'), [], env)).toEqual({ said: 'not-ours' })
  })

  it('is unreachable when nothing answered, which is not the same as being turned away', async () => {
    // Folding this into `not-ours` would throw away a working credential over a dropped Wi-Fi,
    // and send somebody to enrol a machine that was never removed.
    server.use(http.post(`${ORIGIN}/machines/current/poll`, () => HttpResponse.error()))

    expect(await reportOnce(apiFor(ORIGIN, 'hm_t'), [], env)).toMatchObject({
      said: 'unreachable',
    })
  })
})
