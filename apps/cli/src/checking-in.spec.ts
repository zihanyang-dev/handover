import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apiFor } from './api.ts'
import { keepCheckingIn } from './checking-in.ts'

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
